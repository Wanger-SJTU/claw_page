---
title: "在 GeForce RTX 3060 上启用 GPUDirect Storage（GDS）全记录"
date: 2026-08-22
tags: [GPU, 存储, 性能, GDS, NVIDIA]
---

> 目标：在一台 GEM12 迷你主机（RTX 3060，经 OCuLink/M.2 显卡坞扩展）上启用 NVIDIA GPUDirect Storage（cuFile / nvidia-fs），让 NVMe SSD 直接 DMA 到 GPU 显存，绕开 CPU 中转。最终实测 GDS 读带宽拉到 **5 GiB/s**。

## 目录

1. [背景：为什么需要 GDS](#背景为什么需要-gds)
2. [实现原理](#实现原理)
3. [操作步骤](#操作步骤)
4. [测试代码与验证](#测试代码与验证)
5. [踩坑与经验](#踩坑与经验)

---

## 背景：为什么需要 GDS

在 LLM / Agent 场景里，存储逐渐成为真实瓶颈。一次推理里模型加载、KV Cache 落盘、向量检索、数据集读取都涉及「存储 ↔ GPU 显存」的数据搬运。

传统路径要经过 CPU 内存做一次中转：

```
传统 IO：  NVMe SSD ──DMA──> CPU 内存 ──cudaMemcpy──> GPU 显存
                              ↑
                        占用 CPU + 多一次拷贝
```

GPUDirect Storage（GDS）让 NVMe 控制器**直接 DMA 到 GPU 显存**：

```
GDS IO：   NVMe SSD ────────DMA（PCIe P2P）────────> GPU 显存
                                    ↑
                          CPU 完全不参与数据搬运
```

GDS 由两部分组成：

| 组件 | 位置 | 职责 |
|---|---|---|
| `libcufile` | 用户态库 | 提供 `cuFileRead/Write/HandleRegister/BufRegister` API |
| `nvidia-fs` | 内核模块 | 把 GPU 显存 pin 成可 DMA 的物理页，交给 NVMe 驱动 |

---

## 实现原理

### 1. 数据通路：P2P 内存 pinning 是关键

GDS 的核心难题是：**NVMe 控制器不认识 GPU 显存地址**。显存（BAR 空间）的物理地址对第三方设备（NVMe）不可见，必须先把它们「翻译」成 PCIe 总线地址，这个动作叫 **P2P pinning**。

```
cuFileBufRegister(d_buf, size, 0)
        │  用户态
        ▼
nvidia-fs 内核模块
        │  调用 nvidia_p2p_get_pages_persistent()
        ▼
NVIDIA RM（资源管理器）
        │  创建 ThirdPartyP2P (NV503C) 对象
        │  把 GPU BAR1 物理页映射成 PCIe 总线地址
        ▼
返回 DMA 地址列表（dma_addr_t[]）
        │  注册到 NVMe 驱动（nvme_v1_register_nvfs_dma_ops）
        ▼
NVMe 控制器直接 DMA 读写这些地址 → 数据直达显存
```

两个关键的内核符号：

- `nvidia_p2p_get_pages_persistent()`：GPU 驱动导出，负责把 GPU 内存页 pin 成 DMA 地址。新版按 PID 查找 `ThirdPartyP2P` 对象。
- `nvme_v1_register_nvfs_dma_ops()`：NVMe 驱动导出，nvidia-fs 通过 `__symbol_get()` 去 hook 它，把自己的 DMA 操作挂到 NVMe 请求路径上。

### 2. GeForce 为什么报 -22

RTX 3060 实测 `nvidia_p2p_get_pages_persistent` 返回 `-22 (EINVAL)`。

关键在于区分错误码：

| 返回值 | 含义 | 能否补丁 |
|---|---|---|
| `-22 (EINVAL)` | 参数非法 / 对象缺失 | **能**，是门控逻辑拒绝 |
| `-95 (ENOTSUPP)` | 驱动明确不支持 | 难，是能力缺失 |

`-22` 说明驱动**有能力**做 P2P，只是 RM 拿不到 `ThirdPartyP2P`（NV503C）对象——NVIDIA **从未为 GeForce 创建这个对象**。这是纯软件产品分级（segmentation），不是硬件限制。

### 3. BAR1 P2P 补丁原理

当前驱动是 **open kernel module**（580.173.02），`src/nvidia/` 源码可改。补丁思路是「把 GeForce 当 Hopper 用」：强制开启 P2P 覆盖位 + 把 BAR1 P2P 的 HAL 函数强制路由到 `_GH100`（Hopper）实现。

**`kernel_bif.c` 三处 registry override**（`_kbifInitRegistryOverrides`）：

```diff
-    pKernelBif->p2pOverride = BIF_P2P_NOT_OVERRIDEN;
+    pKernelBif->p2pOverride = 0x11;   /* READ + WRITE 均启用 P2P */
 
-    pKernelBif->forceP2PType = NV_REG_STR_RM_FORCE_P2P_TYPE_DEFAULT;
+    pKernelBif->forceP2PType = NV_REG_STR_RM_FORCE_P2P_TYPE_PCIEP2P;
 
-    pKernelBif->pcieP2PType = NV_REG_STR_RM_PCIEP2P_TYPE_DEFAULT;
+    pKernelBif->pcieP2PType = NV_REG_STR_RM_PCIEP2P_TYPE_BAR1;
```

**`g_kern_bus_nvoc.c` 五处 HAL 重命名**（default/else 分支）：

```diff
-    ... = kbusGetBar1P2PDmaInfo_395e98;
+    ... = kbusGetBar1P2PDmaInfo_GH100;
-    ... = kbusCreateP2PMappingForBar1P2P_395e98;
+    ... = kbusCreateP2PMappingForBar1P2P_GH100;
-    ... = kbusRemoveP2PMappingForBar1P2P_395e98;
+    ... = kbusRemoveP2PMappingForBar1P2P_GH100;
-    ... = kbusHasPcieBar1P2PMapping_d69453;
+    ... = kbusHasPcieBar1P2PMapping_GH100;
-    ... = kbusIsPcieBar1P2PMappingSupported_d69453;
+    ... = kbusIsPcieBar1P2PMappingSupported_GH100;
```

> 为什么是 `_GH100`？因为 Hopper（H100）是官方支持 BAR1 P2P 的架构，它的 HAL 实现是「完整可用的 P2P 逻辑」。GeForce 对应的 `_395e98`/`_d69453` 版本是被阉割过的空实现或降级路径。强制改到 `_GH100` 就等于把 Hopper 的 P2P 能力「借」给 GeForce。

### 4. GSP 固件：补丁为何会被静默绕过

580 系列默认 `EnableGpuFirmware: 18`（= `MODE_DEFAULT(0x2) | POLICY_ALLOW_FALLBACK(0x10)`），RM 跑在**闭源 GSP 固件**里。此时 `src/nvidia/` 的源码补丁**根本不生效**——真正跑的是固件里的二进制逻辑。

必须强制 RM 跑在 CPU（open RM）：

```
options nvidia NVreg_EnableGpuFirmware=0
```

这是最容易漏掉的一层：不关 GSP，前面的补丁全部白打。

---

## 操作步骤

环境：Ubuntu + RTX 3060 + 已装 open kernel module 580.173.02 + 已装 `nvidia-fs`/`libcufile`（GDS 工具）。

### 步骤 0：前置条件

```bash
# 关闭 IOMMU，确保 DMA 直通（GRUB cmdline 加 amd_iommu=off）
# 确认 BIOS 已开 ReBAR（BAR1 大小 16 GiB）
sudo dmesg | grep -i iommu   # 应显示 IOMMU disabled
nvidia-smi                   # 确认驱动 580.173.02
```

### 步骤 1：换 linux-nvidia 内核（NVMe 侧）

普通 `generic` 内核的 `nvme.ko` 不导出 `nvme_v1_register_nvfs_dma_ops`，必须换 Ubuntu 官方的 `linux-nvidia` 内核：

```bash
sudo apt install linux-image-6.8.0-1054-nvidia linux-headers-6.8.0-1054-nvidia
# 重启进新内核后验证符号已导出
sudo grep nvme_v1_register_nvfs_dma_ops /proc/kallsyms
# 应有输出（generic 内核则无）
```

### 步骤 2：下载源码 + 打补丁

```bash
git clone https://github.com/NVIDIA/open-gpu-kernel-modules.git
cd open-gpu-kernel-modules
git checkout 580.173.02   # 与当前驱动版本一致
```

按上文第 3 节改两处：
- `src/nvidia/src/kernel/gpu/bif/kernel_bif.c`（3 处 override）
- `src/nvidia/generated/g_kern_bus_nvoc.c`（5 处 `_GH100` 重命名）

> 补丁可参考 [Panchovix/open-gpu-kernel-modules](https://github.com/Panchovix/open-gpu-kernel-modules) 对 4090/5090 的完整改动，用 `diff` 对比其 fork 与 stock 得到。

### 步骤 3：编译 + 安装

```bash
# 编译（指定目标内核）
make modules KERNEL_UNAME=6.8.0-1054-nvidia -j$(nproc)

# 精简 + 压缩
strip --strip-debug kernel-open/nvidia.ko
zstd -T0 kernel-open/nvidia.ko -o nvidia.ko.zst

# 备份原模块后替换
sudo cp nvidia.ko.zst /lib/modules/6.8.0-1054-nvidia/updates/dkms/nvidia.ko.zst
sudo depmod 6.8.0-1054-nvidia
sudo update-initramfs -u -k 6.8.0-1054-nvidia
```

### 步骤 4：禁用 GSP 固件

```bash
echo "options nvidia NVreg_EnableGpuFirmware=0" \
  | sudo tee /etc/modprobe.d/nvidia-gsp-disable.conf
sudo update-initramfs -u -k 6.8.0-1054-nvidia
```

### 步骤 5：重启 + 验证

```bash
sudo reboot
# 重启后
cat /proc/driver/nvidia/params | grep EnableGpuFirmware   # 应为 0
sudo dmesg | grep -iE "nvidia_p2p|nvfs"                    # 应无 -22
```

---

## 测试代码与验证

### 1. 平台检查（gdscheck）

```bash
/usr/local/cuda/gds/tools/gdscheck -p
# 期望输出：
#   GPU index 0 NVIDIA GeForce RTX 3060 bar:1 bar size (MiB):16384 supports GDS, IOMMU State: Disabled
#   Platform verification succeeded

/usr/local/cuda/gds/tools/gdscheck -f /tmp/gdstest.bin
# 期望输出：GDS register success
```

> 注意：`gdscheck -p` 只读驱动能力位，**不实际 pin GPU page**。它显示 `supports GDS` 不代表 P2P 真通，真正的判据是下一步 `gdsio` 跑出真实吞吐。

### 2. 带宽测试（gdsio）

```bash
# 写测试：GPU 显存 → NVMe（GDS 直通）
gdsio -f /tmp/gdstest.bin -d 0 -w 1 -s 1G -i 1M -I 1 -x 0 -V

# 读测试：NVMe → GPU 显存，4 线程拉满队列深度
gdsio -f /tmp/gdstest.bin -d 0 -w 4 -s 1G -i 1M -I 0 -x 0 -V

# 对照：CPU-only 路径（-x 1），用于对比 P2P 收益
gdsio -f /tmp/gdstest.bin -d 0 -w 4 -s 1G -i 1M -I 0 -x 1
```

关键参数：

| 参数 | 含义 |
|---|---|
| `-x 0` | `Storage->GPU (GDS)`，即 P2P 直通路径 |
| `-I 1/0` | 写 / 读 |
| `-w N` | 并发线程数（队列深度） |
| `-V` | 读写后校验数据完整性 |
| `-s` | 数据量，`-i` 单次 IO 大小 |

实测结果：

| 场景 | 吞吐 |
|---|---|
| GDS 写（单线程） | 1.9 GiB/s（QD1 限制） |
| GDS 读（4 线程） | **5.02 GiB/s**（拉满 PCIe 4.0） |

吞吐随队列深度从 1.9 → 5 GiB/s 线性扩展，这是 **P2P 直通生效的铁证**——如果是 CPU 中转的 compat mode，会被 CPU 拷贝带宽卡住且不随 QD 扩展。

### 3. cuFile 最小示例

`gdsio` 是黑盒工具，下面是一个调用 cuFile API 的最小程序，展示 GDS 的真实编程接口：

```c
// gds_test.c — 最小 cuFile 示例：GPU 显存 ↔ NVMe 直通读写
#include <cufile.h>
#include <cuda_runtime.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#include <stdint.h>

#define SIZE (1UL << 30)   // 1 GiB

int main(void) {
    const char *path = "/tmp/gdstest.bin";
    void *d_buf;
    char *h_buf = malloc(SIZE);
    ssize_t ret;

    // 1. 打开 cuFile 驱动
    cuFileDriverOpen();

    // 2. 分配并填充 GPU 显存
    cudaMalloc(&d_buf, SIZE);
    memset(h_buf, 0xAB, SIZE);
    cudaMemcpy(d_buf, h_buf, SIZE, cudaMemcpyHostToDevice);

    // 3. 注册 GPU 内存 —— GDS 核心：pin 物理页 + 拿 DMA 地址
    cuFileBufRegister(d_buf, SIZE, 0);

    // 4. 打开文件（O_DIRECT 绕过 page cache）并注册 handle
    int fd = open(path, O_CREAT | O_RDWR | O_DIRECT, 0644);
    CUfileDescr_t descr;
    memset(&descr, 0, sizeof(descr));
    descr.type = CU_FILE_handle_TYPE_OPAQUE_FD;
    descr.cookie = (void *)(uintptr_t)fd;
    CUfileHandle_t fh;
    cuFileHandleRegister(&fh, &descr);

    // 5. GDS 写：GPU 显存 → NVMe（DMA 直通，CPU 不参与）
    ret = cuFileWrite(fh, d_buf, SIZE, 0, 0);
    if (ret != SIZE) { fprintf(stderr, "write: %zd\n", ret); return 1; }

    // 6. GDS 读：NVMe → GPU 显存
    cudaMemset(d_buf, 0, SIZE);
    ret = cuFileRead(fh, d_buf, SIZE, 0, 0);
    if (ret != SIZE) { fprintf(stderr, "read: %zd\n", ret); return 1; }

    // 7. 校验数据完整性
    cudaMemcpy(h_buf, d_buf, SIZE, cudaMemcpyDeviceToHost);
    for (size_t i = 0; i < SIZE; i++)
        if (h_buf[i] != 0xAB) { fprintf(stderr, "verify fail @%zu\n", i); return 1; }
    puts("verify OK");

    // 8. 清理
    cuFileBufDeregister(d_buf);
    cuFileHandleDeregister(fh);
    close(fd);
    cudaFree(d_buf);
    cuFileDriverClose();
    return 0;
}
```

编译运行：

```bash
nvcc -o gds_test gds_test.c -I/usr/local/cuda/include -L/usr/local/cuda/lib64 -lcuda -lcufile
./gds_test          # 期望输出 verify OK
```

> 判定 GDS 是否真生效：跑完后 `sudo dmesg | grep -iE "nvidia_p2p|nvfs"` 应**没有** `-22` 报错。若出现 `nvidia_p2p_get_pages_persistent ... -22`，说明 P2P 未打通，走了 CPU 回退。

---

## 踩坑与经验

1. **`gdscheck` 是假阳性来源**：`supports GDS` 只查能力位，不实际 pin page。真正的判据是 `nvidia_p2p_get_pages` 不返回 `-22` + `gdsio` 跑出随 QD 扩展的高吞吐。

2. **补丁要打全**：只改 `p2pOverride` + `pcieP2PType`、漏掉 `forceP2PType`，P2P 仍返回 `-22`。建议直接 `diff` Panchovix fork 与 stock 得到完整补丁，而不是手写。

3. **GDS 是「GPU 补丁 + NVMe 补丁」两层**，GeForce 分级只影响 GPU 侧；NVMe 侧必须用 `linux-nvidia` 内核（或自己给内核开 `CONFIG_NVME_NVFS`）。

4. **GSP 固件静默绕过源码补丁**：580 系列默认 `EnableGpuFirmware: 18`，不设 `=0` 补丁全白打。这是最容易漏的一步。

5. **区分 `-22` 与 `-95`**：`EINVAL` 是门控拒绝（可补丁），`ENOTSUPP` 才是真不支持（难补）。

6. **显卡坞不是根因**：OCuLink/M.2 是被动式直通，不破坏 P2P（区别于主动式 Thunderbolt 坞）。GPU 与 NVMe 只要在同一 root complex 即可。
