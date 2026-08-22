---
title: "在 GeForce RTX 3060 上启用 GPUDirect Storage（GDS）全记录"
date: 2026-08-22
tags: [GPU, 存储, 性能, GDS, NVIDIA]
---

> 目标：在一台 GEM12 迷你主机（RTX 3060，经 OCuLink/M.2 显卡坞扩展）上启用 NVIDIA GPUDirect Storage（cuFile / nvidia-fs），让 NVMe SSD 直接 DMA 到 GPU 显存，绕开 CPU 中转。

## 结论先行

**GeForce 卡官方不支持 GDS，但这不是硬件限制，而是软件层面的产品分级（segmentation）。** 打补丁即可绕过，最终实测 GDS 读带宽拉到 **5 GiB/s**（PCIe 4.0 NVMe 上限）。

完整链条需要打通**三层**：

1. **GPU 侧**：GeForce 驱动从不创建 `ThirdPartyP2P`（NV503C）对象 → `nvidia_p2p_get_pages_persistent` 返回 `-22 (EINVAL)`，需要打 BAR1 P2P 补丁。
2. **NVMe 侧**：NVMe 驱动必须导出 `nvme_v1_register_nvfs_dma_ops`，让 nvidia-fs 能 hook 存储栈。
3. **GSP 固件**：必须关闭，否则 GPU 侧补丁被闭源 GSP 固件绕过。

## 根因：GeForce 的软件分级

GDS 的数据通路依赖 `nvidia_p2p_get_pages_persistent`（旧 API 为 `nvidia_p2p_get_pages`），它需要进程已持有 `ThirdPartyP2P` 对象。NVIDIA 从未为 GeForce 创建该对象，于是 RM 直接返回 `NV_ERR_INVALID_ARGUMENT` → `-EINVAL`。

关键区分：`-22 (EINVAL)` 不是 `-95 (ENOTSUPP)`——说明驱动**有能力**做 P2P，只是**被门控拒绝**，所以补丁可解。

排查中发现几个容易误导的点：

- **`gdscheck -p` 显示 "supports GDS" 不代表 P2P 真的通**：它只读驱动能力位，不实际 pin GPU page。真正的验证是 `nvidia_p2p_get_pages(_persistent)` 不返回 `-22`。
- **显卡坞不是根因**：OCuLink/M.2 是被动式直通 PCIe 信号，不破坏 P2P（区别于主动式 Thunderbolt 坞）。GPU 与 NVMe 在同一 root complex，无中间 switch。
- **IOMMU**：`amd_iommu=off` 确保 DMA 直通。

## 第一层：GPU 侧 BAR1 P2P 补丁

当前驱动是 **open kernel module**（可改 `src/nvidia/` 源码）。补丁共 8 处改动：

**`src/nvidia/src/kernel/gpu/bif/kernel_bif.c`**（`_kbifInitRegistryOverrides` 里 3 处）：

| 字段 | 默认值 | 改为 |
|---|---|---|
| `p2pOverride` | `BIF_P2P_NOT_OVERRIDEN` | `0x11`（READ+WRITE 均启用） |
| `forceP2PType` | `..._DEFAULT` | `NV_REG_STR_RM_FORCE_P2P_TYPE_PCIEP2P` |
| `pcieP2PType` | `..._DEFAULT` | `NV_REG_STR_RM_PCIEP2P_TYPE_BAR1` |

**`src/nvidia/generated/g_kern_bus_nvoc.c`**（5 处 BAR1 P2P HAL 的 default/else 分支，强制走 `_GH100` Hopper 实现）：

- `kbusGetBar1P2PDmaInfo`
- `kbusCreateP2PMappingForBar1P2P`
- `kbusRemoveP2PMappingForBar1P2P`
- `kbusHasPcieBar1P2PMapping`
- `kbusIsPcieBar1P2PMappingSupported`

> 踩坑：早期只改了 `p2pOverride` + `pcieP2PType`，**漏了 `forceP2PType`**，导致补丁不完整、P2P 仍返回 `-22`。完整补丁参考 Panchovix/tinygrad 对 4090/5090 的做法，用 `diff` 对比其 fork 与 stock 驱动得到。

## 第二层：NVMe 驱动的 GDS 支持

nvidia-fs 通过 `__symbol_get("nvme_v1_register_nvfs_dma_ops")` 去 hook NVMe 驱动，但普通 Ubuntu `generic` 内核**不导出**该符号（`CONFIG_NVME_NVFS` 未开）。

解法：换用 Ubuntu 官方打包的 **`linux-nvidia`** 内核（如 `6.8.0-1054-nvidia`），其 `nvme.ko` 已导出 `nvme_v1_register_nvfs_dma_ops`。

## 第三层：关闭 GSP 固件

最容易忽略的一层。580 系列驱动默认 `EnableGpuFirmware: 18`（= `MODE_DEFAULT|POLICY_ALLOW_FALLBACK`），RM 跑在**闭源 GSP 固件**里，`src/nvidia/` 的补丁被完全绕过。

强制 RM 跑在 CPU（open RM）：

```
options nvidia NVreg_EnableGpuFirmware=0
```

不关 GSP，前面所有补丁等于白打。

## 验证结果

重启后（`EnableGpuFirmware: 0` + 完整补丁 + linux-nvidia 内核）：

| 检查项 | 结果 |
|---|---|
| `dmesg` 的 `-22` 错误 | 消失 |
| `gdscheck -p` | `supports GDS` + `Platform verification succeeded` |
| `gdscheck -f` | `GDS register success` |
| `gdsio` 写（单线程） | 1.9 GiB/s（QD1 限制） |
| `gdsio` 读（4 线程） | **5.02 GiB/s**（拉满 PCIe 4.0） |

吞吐随队列深度从 1.9 → 5 GiB/s 线性扩展，证明走的是 GPU↔NVMe 直通（P2P），而非 CPU 中转的 compat mode。

## 经验总结

1. **验证要到位**：`gdscheck` "supports GDS" 是假阳性来源，必须确认 `nvidia_p2p_get_pages` 不再报 `-22`。
2. **GDS 是「GPU 补丁 + NVMe 补丁」两层**，缺一不可；GeForce 分级只影响 GPU 侧。
3. **GSP 固件会静默绕过源码补丁**，`NVreg_EnableGpuFirmware=0` 是 580 系列踩坑必查项。
4. **区分 `-22` 与 `-95`**：前者可补丁，后者才是真不支持。
