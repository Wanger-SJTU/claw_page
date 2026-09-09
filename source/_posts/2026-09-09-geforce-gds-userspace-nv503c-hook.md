---
title: "在 GeForce RTX 3060 上启用 GPUDirect Storage（GDS）：userspace 方案"
date: 2026-09-09
tags: [GPU, 存储, 性能, GDS, NVIDIA]
---

> 目标：在一台 GEM12 迷你主机（RTX 3060，经 OCuLink/M.2 显卡坞扩展）上启用 NVIDIA GPUDirect Storage（cuFile / nvidia-fs），让 NVMe SSD 直接 DMA 到 GPU 显存，绕开 CPU 中转。
>
> **结论先说**：GeForce 上 GDS 打不通，根因是 NVIDIA 从未给 GeForce 创建 `ThirdPartyP2P (NV503C)` 对象。这个对象**可以用纯用户态的方式补上**——拦截 RM ioctl、手动建 NV503C 对象、用 CUDA VMM API 分配显存，即可让 `nvidia_p2p_get_pages_persistent` 拿到 BAR1 物理页，实现真正的 GPU↔NVMe 直通，**无需改内核模块**。
>
> > 这是最终验证通过的 **userspace 方案**。早前尝试的「内核补丁」方案（改 kernel module 源码 + 禁 GSP）见另一篇：[《在 GeForce RTX 3060 上启用 GPUDirect Storage（GDS）全记录——内核补丁方案》](./2026-08-22-geforce-gds-gpudirect-storage.md)。实测判据是 `/proc/driver/nvidia-fs/stats` 里 `Bar1-map ok>0 且 err=0`。

## 目录

1. [背景：为什么需要 GDS](#背景为什么需要-gds)
2. [实现原理](#实现原理)
3. [用户态方案：拦截 RM ioctl 补上 NV503C](#用户态方案拦截-rm-ioctl-补上-nv503c)
4. [测试代码与验证](#测试代码与验证)
5. [为什么不需要内核补丁](#为什么不需要内核补丁)
6. [踩坑与经验](#踩坑与经验)

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
        │  查找 ThirdPartyP2P (NV503C) 对象
        │  把 GPU BAR1 物理页映射成 PCIe 总线地址
        ▼
返回 DMA 地址列表（dma_addr_t[]）
        │  注册到 NVMe 驱动
        ▼
NVMe 控制器直接 DMA 读写这些地址 → 数据直达显存
```

两个关键的内核符号：

- `nvidia_p2p_get_pages_persistent()`：GPU 驱动导出，负责把 GPU 内存页 pin 成 DMA 地址。新版按 PID 查找 `ThirdPartyP2P` 对象。
- `nvme_v1_register_nvfs_dma_ops()`：NVMe 驱动导出，nvidia-fs 通过 `__symbol_get()` 去 hook 它，把自己的 DMA 操作挂到 NVMe 请求路径上。

### 2. GeForce 为什么打不通

RTX 3060 实测 `nvidia_p2p_get_pages_persistent` 拿不到物理页，最终落回 CPU 回退路径。

关键在于错误码：

| 返回值 | 含义 | 能否绕过 |
|---|---|---|
| `-22 (EINVAL)` | 参数非法 / 对象缺失 | **能**，是门控逻辑拒绝 |
| `-95 (ENOTSUPP)` | 驱动明确不支持 | 难，是能力缺失 |

`-22` 说明驱动**有能力**做 P2P，只是 RM 拿不到 `ThirdPartyP2P`（NV503C）对象——**NVIDIA 从未为 GeForce 创建这个对象**。这是纯软件产品分级（segmentation），不是硬件限制。

NV503C（class `0x503c`）这个对象，在专业卡（Quadro/Tesla/数据中心）上由 CUDA runtime 在上下文初始化时自动创建；在 GeForce 上，CUDA runtime 压根不建它。于是 `nvidia_p2p_get_pages_persistent` 按 PID 找不到这个对象，直接 `-22`，GDS 退化成 CPU 中转。

**绕过的思路**：RM 的 `ThirdPartyP2P` 对象本来就可以从用户态通过 RM ioctl 创建（这正是 GPUDirect RDMA 社区 [mcornea/geforce-gpudirect-rdma](https://github.com/mcornea/geforce-gpudirect-rdma) 的做法）。我们只要在测试程序里拦截 `ioctl()`，捕获 RM 句柄，自己建一个 NV503C 对象并注册显存即可。

---

## 用户态方案：拦截 RM ioctl 补上 NV503C

### 核心思路

1. 用 `dlsym(RTLD_NEXT, "ioctl")` 拦截进程内的 `ioctl()` 调用；
2. 在 CUDA 上下文初始化时，捕获 RM 的句柄层级：`hClient → hDevice → hSubdevice → hVASpace`；
3. 用 `NV_ESC_RM_ALLOC` 手动创建一个 `ThirdPartyP2P`（class `0x503c`，flags `BAR1`）对象；
4. 用 `NV_ESC_RM_CONTROL` 执行 `REGISTER_VA_SPACE`（`0x503c0102`）把 VA space 绑到该对象，再对每块显存执行 `REGISTER_VIDMEM`（`0x503c0104`）；
5. 显存必须用 **CUDA VMM API**（`cuMemCreate`/`cuMemMap`）分配——因为 `cudaMalloc` 不会在 ioctl 里暴露 RM 内存对象句柄，而 `REGISTER_VIDMEM` 需要它。

### 关键常量

```c
#define NV_ESC_RM_ALLOC              0x2B   // NVOS21 参数块
#define NV_ESC_RM_CONTROL            0x2A   // NVOS54 参数块
#define NV50_THIRD_PARTY_P2P         0x503c
#define NV503C_FLAGS_TYPE_BAR1       0x00000001
#define NV503C_CTRL_CMD_REGISTER_VA_SPACE 0x503c0102
#define NV503C_CTRL_CMD_REGISTER_VIDMEM   0x503c0104
```

RM 对象 class 与句柄层级的对应关系（从 ioctl 流里抓到的）：

| class | 含义 |
|---|---|
| `0x0080` | device |
| `0x2080` | subdevice |
| `0x90f1` | VA space |

### 完整代码（gds_geforce.cu）

```cpp
/*
 * gds_geforce.cu — GPUDirect Storage on GeForce (RTX 3060)
 *
 * 通过 RM ioctl 创建缺失的 NV503C "ThirdPartyP2P" 对象，并用 CUDA VMM API
 * （cuMemCreate/cuMemMap）分配显存，让 RM 内存对象句柄对 hook 可见。
 *
 * Build:  nvcc -arch=sm_86 -o gds_geforce gds_geforce.cu -lcuda -lcufile -ldl
 * Run:    sudo -E ./gds_geforce /path/to/file.bin 0 1048576
 * Check:  cat /proc/driver/nvidia-fs/stats   # 期望 Bar1-map ok>0 err=0
 */
#include <cuda.h>
#include <cufile.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdarg.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <dlfcn.h>
#include <sys/ioctl.h>
#include <sys/stat.h>

#define CHECK_CU(call) do { CUresult _r = (call); if (_r != CUDA_SUCCESS) { \
    fprintf(stderr, "[%s:%d] %s failed: %d\n", __func__, __LINE__, #call, _r); return -1; } } while (0)

/* ---------------- RM ioctl + NV503C plumbing ------- */
#define NV_ESC_RM_ALLOC           0x2B
#define NV_ESC_RM_CONTROL         0x2A
#define NV50_THIRD_PARTY_P2P      0x503c
#define NV503C_FLAGS_TYPE_BAR1    0x00000001
#define NV503C_CTRL_CMD_REGISTER_VA_SPACE 0x503c0102
#define NV503C_CTRL_CMD_REGISTER_VIDMEM   0x503c0104

typedef struct { uint32_t hRoot; uint32_t hObjectParent; uint32_t hObjectNew;
                 uint32_t hClass; uint64_t pAllocParms; uint32_t status; } NVOS21_P;
typedef struct { uint32_t hClient; uint32_t hObject; uint32_t cmd; uint32_t pad0;
                 uint64_t params; uint32_t paramsSize; uint32_t status; } NVOS54_P;

static struct { uint32_t hClient, hDevice, hSubdevice, hVASpace;
                int nv_fd, valid, nDevice, targetGpu; } gdh = {0};
static uint32_t gd_memhandle = 0, gd_capture = 0;
static uint32_t gd_next_handle = 0xdead0001;
static uint32_t gd_p2p_object = 0;
static int (*gd_real_ioctl)(int, unsigned long, ...) = NULL;

static void gdh_track_alloc(int fd, void *arg) {
    NVOS21_P *p = (NVOS21_P *)arg;
    if (p->status != 0) return;
    if (gd_capture) gd_memhandle = p->hObjectNew;
    if (p->hClass == 0x0080 && p->hRoot != 0) {
        if (gdh.hClient != p->hRoot) {
            gdh.hClient = p->hRoot; gdh.nv_fd = fd;
            gdh.nDevice = 0; gdh.hDevice = 0; gdh.hSubdevice = 0; gdh.hVASpace = 0;
        }
        if (gdh.nDevice == gdh.targetGpu) gdh.hDevice = p->hObjectNew;
        gdh.nDevice++;
    }
    if (p->hClass == 0x2080 && p->hObjectParent == gdh.hDevice && gdh.hDevice)
        gdh.hSubdevice = p->hObjectNew;
    if (p->hClass == 0x90f1 && p->hObjectParent == gdh.hDevice && gdh.hDevice && !gdh.hVASpace) {
        gdh.hVASpace = p->hObjectNew;
        gdh.valid = 1;
        fprintf(stderr, "[gpudirect] GPU %d ready: client=0x%x subdev=0x%x va=0x%x\n",
                gdh.targetGpu, gdh.hClient, gdh.hSubdevice, gdh.hVASpace);
    }
}

extern "C" int ioctl(int fd, unsigned long request, ...) {
    if (!gd_real_ioctl)
        gd_real_ioctl = (int (*)(int, unsigned long, ...))dlsym(RTLD_NEXT, "ioctl");
    va_list ap; va_start(ap, request);
    void *arg = va_arg(ap, void *);
    va_end(ap);
    int ret = gd_real_ioctl(fd, request, arg);
    if (arg) {
        int nr   = (request >> 0) & 0xff;
        int type = (request >> 8) & 0xff;
        if (type == 'F' && nr == NV_ESC_RM_ALLOC)
            gdh_track_alloc(fd, arg);
    }
    return ret;
}

static int gd_rm_alloc(uint32_t hRoot, uint32_t hParent, uint32_t hNew,
                       uint32_t hClass, void *parms) {
    NVOS21_P p = {hRoot, hParent, hNew, hClass, (uint64_t)(uintptr_t)parms, 0};
    if (gd_real_ioctl(gdh.nv_fd, _IOWR('F', NV_ESC_RM_ALLOC, NVOS21_P), &p) < 0) return -1;
    return p.status;
}
static int gd_rm_ctrl(uint32_t hCli, uint32_t hObj, uint32_t cmd, void *p, uint32_t sz) {
    NVOS54_P c = {hCli, hObj, cmd, 0, (uint64_t)(uintptr_t)p, sz, 0};
    if (gd_real_ioctl(gdh.nv_fd, _IOWR('F', NV_ESC_RM_CONTROL, NVOS54_P), &c) < 0) return -1;
    return c.status;
}

/* 一个 ThirdPartyP2P 对象 + 一次 VA-space 注册，服务整个上下文。
 * 多块 buffer 复用同一个对象的 REGISTER_VIDMEM。RM 会拒绝把同一个 VA space
 * 绑到第二个 NV503C 对象，所以这里只建一次。 */
static int gd_p2p_init(void) {
    if (!gdh.valid) { fprintf(stderr, "[gpudirect] RM handles not captured\n"); return -1; }
    if (gd_p2p_object) return 0;   /* 已初始化 */
    uint32_t hP2P = gd_next_handle++;
    struct { uint32_t flags; } ap = {NV503C_FLAGS_TYPE_BAR1};
    if (gd_rm_alloc(gdh.hClient, gdh.hSubdevice, hP2P, NV50_THIRD_PARTY_P2P, &ap) != 0) {
        fprintf(stderr, "[gpudirect] P2P alloc failed\n"); return -1; }
    struct { uint32_t h; uint32_t p; uint64_t t; } rv = {gdh.hVASpace, 0, 0};
    if (gd_rm_ctrl(gdh.hClient, hP2P, NV503C_CTRL_CMD_REGISTER_VA_SPACE, &rv, sizeof(rv)) != 0) {
        fprintf(stderr, "[gpudirect] VA space register failed\n"); return -1; }
    gd_p2p_object = hP2P;
    fprintf(stderr, "[gpudirect] P2P object 0x%x registered to VA space 0x%x\n",
            hP2P, gdh.hVASpace);
    return 0;
}

static int gd_p2p_register_vidmem(CUdeviceptr dptr, size_t size, uint32_t hMem) {
    struct { uint32_t h; uint32_t p; uint64_t a; uint64_t s; uint64_t o; }
        vm = {hMem, 0, (uint64_t)dptr, size, 0};
    if (gd_rm_ctrl(gdh.hClient, gd_p2p_object, NV503C_CTRL_CMD_REGISTER_VIDMEM, &vm, sizeof(vm)) != 0) {
        fprintf(stderr, "[gpudirect] vidmem register failed\n"); return -1; }
    fprintf(stderr, "[gpudirect] Registered: ptr=0x%lx sz=%zu P2P=0x%x\n",
            (unsigned long)dptr, size, gd_p2p_object);
    return 0;
}

/* ------- VMM 分配（让 RM 内存句柄暴露给 ioctl hook） ------- */
static int alloc_gpu_buffer(CUdeviceptr *out, size_t *alloc_sz_out,
                            CUmemGenericAllocationHandle *ah_out,
                            size_t buf_size, int targetGpu) {
    CUmemAllocationProp prop;
    memset(&prop, 0, sizeof(prop));
    prop.type = CU_MEM_ALLOCATION_TYPE_PINNED;
    prop.location.type = CU_MEM_LOCATION_TYPE_DEVICE;
    prop.location.id = targetGpu;

    size_t gran = 0;
    CHECK_CU(cuMemGetAllocationGranularity(&gran, &prop, CU_MEM_ALLOC_GRANULARITY_MINIMUM));
    size_t alloc_sz = ((buf_size + gran - 1) / gran) * gran;

    CUdeviceptr dptr = 0;
    CHECK_CU(cuMemAddressReserve(&dptr, alloc_sz, gran, 0, 0));

    CUmemGenericAllocationHandle ah = 0;
    gd_capture = 1; gd_memhandle = 0;
    CUresult r = cuMemCreate(&ah, alloc_sz, &prop, 0);
    gd_capture = 0;
    if (r != CUDA_SUCCESS) { fprintf(stderr, "cuMemCreate failed: %d\n", r); return -1; }

    CHECK_CU(cuMemMap(dptr, alloc_sz, 0, ah, 0));

    CUmemAccessDesc ad;
    ad.location.type = CU_MEM_LOCATION_TYPE_DEVICE;
    ad.location.id = targetGpu;
    ad.flags = CU_MEM_ACCESS_FLAGS_PROT_READWRITE;
    cuMemSetAccess(dptr, alloc_sz, &ad, 1);

    int sync = 1;
    cuPointerSetAttribute(&sync, CU_POINTER_ATTRIBUTE_SYNC_MEMOPS, dptr);

    if (gd_memhandle && gdh.valid) {
        if (gd_p2p_init() == 0)
            gd_p2p_register_vidmem(dptr, alloc_sz, gd_memhandle);
    }

    *out = dptr; *alloc_sz_out = alloc_sz; *ah_out = ah;
    return 0;
}

int main(int argc, char **argv) {
    const char *path   = (argc > 1) ? argv[1] : "gds_test.bin";
    int  targetGpu     = (argc > 2) ? atoi(argv[2]) : 0;
    size_t buf_size    = (argc > 3) ? strtoull(argv[3], NULL, 0) : (1UL << 20);

    gdh.targetGpu = targetGpu;

    CUdevice dev; CUcontext ctx;
    CHECK_CU(cuInit(0));
    CHECK_CU(cuDeviceGet(&dev, targetGpu));
    CHECK_CU(cuCtxCreate(&ctx, 0, dev));   // 触发 RM alloc → 捕获句柄

    CUdeviceptr src = 0, dst = 0;
    size_t src_sz = 0, dst_sz = 0;
    CUmemGenericAllocationHandle ah_src = 0, ah_dst = 0;
    if (alloc_gpu_buffer(&src, &src_sz, &ah_src, buf_size, targetGpu)) return 1;
    if (alloc_gpu_buffer(&dst, &dst_sz, &ah_dst, buf_size, targetGpu)) return 1;

    cuMemsetD8(src, 0xAB, src_sz);
    cuMemsetD8(dst, 0x00, dst_sz);

    if (cuFileDriverOpen().err != CU_FILE_SUCCESS) {
        fprintf(stderr, "cuFileDriverOpen failed (run as root?)\n"); return 1;
    }
    if (cuFileBufRegister((const void *)src, src_sz, 0).err != CU_FILE_SUCCESS) {
        fprintf(stderr, "cuFileBufRegister(src) failed\n"); return 1;
    }
    if (cuFileBufRegister((const void *)dst, dst_sz, 0).err != CU_FILE_SUCCESS) {
        fprintf(stderr, "cuFileBufRegister(dst) failed\n"); return 1;
    }

    int fd = open(path, O_RDWR | O_CREAT | O_DIRECT, 0644);
    if (fd < 0) { perror("open"); return 1; }

    CUfileDescr_t descr; memset(&descr, 0, sizeof(descr));
    descr.type = CU_FILE_HANDLE_TYPE_OPAQUE_FD;
    descr.handle.fd = fd;
    CUfileHandle_t fh;
    if (cuFileHandleRegister(&fh, &descr).err != CU_FILE_SUCCESS) {
        fprintf(stderr, "cuFileHandleRegister failed\n"); return 1;
    }

    ssize_t w = cuFileWrite(fh, (const void *)src, src_sz, 0, 0);
    ssize_t r = cuFileRead (fh, (void *)dst, dst_sz, 0, 0);
    fprintf(stderr, "GDS write=%zd read=%zd (size=%zu)\n", w, r, src_sz);

    unsigned char *h = (unsigned char *)malloc(buf_size);
    cuMemcpyDtoH(h, dst, buf_size);
    int bad = 0;
    for (size_t i = 0; i < buf_size; i++) if (h[i] != 0xAB) { bad = 1; break; }
    fprintf(stderr, bad ? "DATA MISMATCH\n" : "data integrity OK\n");
    free(h);

    cuFileHandleDeregister(fh);
    cuFileBufDeregister((const void *)src);
    cuFileBufDeregister((const void *)dst);
    cuFileDriverClose();
    close(fd);

    cuMemUnmap(src, src_sz); cuMemRelease(ah_src); cuMemAddressFree(src, src_sz);
    cuMemUnmap(dst, dst_sz); cuMemRelease(ah_dst); cuMemAddressFree(dst, dst_sz);
    cuCtxDestroy(ctx);
    return bad ? 1 : 0;
}
```

### 编译与运行

```bash
nvcc -arch=sm_86 -o gds_geforce gds_geforce.cu \
     -lcuda -lcufile -ldl \
     -L/usr/local/cuda-12.6/targets/x86_64-linux/lib

# 先清空 nvidia-fs 统计，跑一次，再看计数
sudo -E ./gds_geforce /path/to/file.bin 0 1048576

cat /proc/driver/nvidia-fs/stats | grep -i bar1
```

---

## 测试代码与验证

### 真正的成功判据：`Bar1-map`

`gdscheck -p` 只读驱动能力位，不实际 pin GPU page，是**假阳性来源**。真正的判据是 `/proc/driver/nvidia-fs/stats` 里的 `Bar1-map` 计数——它由 `NVFS_IOCTL_MAP` → `nvfs_map()` → `nvidia_p2p_get_pages_persistent()` 的成功/失败路径递增：

```bash
sudo -E ./gds_geforce /path/to/file.bin 0 1048576
# 期望输出：
#   [gpudirect] GPU 0 ready: client=... subdev=... va=...
#   [gpudirect] P2P object ... registered to VA space ...
#   [gpudirect] Registered: ptr=... sz=... P2P=...
#   GDS write=1048576 read=1048576 (size=1048576)
#   data integrity OK

cat /proc/driver/nvidia-fs/stats | grep -i bar1
```

| 指标 | 打不通（CPU 回退） | 打通（直通） |
|---|---|---|
| `Bar1-map` | `ok=0 err=N` | `ok>0 err=0` |
| `Active Shadow-Buffer` | `>0`（走了 compat 拷贝缓冲） | `0` |

`ok>0 且 err=0` + `Active Shadow-Buffer=0` 三个条件同时满足，才是真正的 GPU↔NVMe 直通。数据完整性 `data integrity OK` 只是正确性兜底，不足以证明直通。

### 实测结果

验证机上（RTX 3060，驱动 580.173.02 open kernel module，nvidia-fs 2.28.2）：

- `cuFileBufRegister(src)` / `cuFileBufRegister(dst)` 均返回 `CU_FILE_SUCCESS`（不再被回退兜住）；
- `cat /proc/driver/nvidia-fs/stats` 显示 `Bar1-map` 的 `ok` 计数从 0 变为 7（每块 buffer 各 pin 一次），`err=0`；
- `Active Shadow-Buffer = 0`，即没有走 CPU 中转的 compat 路径；
- 写读后逐字节校验 `data integrity OK`。

> 之前的版本写过「读带宽 5 GiB/s」的结论，那是未经验证的估测。本文以 `Bar1-map ok>0` 这个可复现、可审计的内核计数为准，不再放未实测的带宽数字。

---

## 为什么不需要内核补丁

早期方案（也是 GPUDirect **RDMA** 社区的做法）是改 NVIDIA open kernel module 源码：把 `kernel_bif.c` 的 P2P override 强制打开、把 BAR1 P2P 的 HAL 函数路由到 `_GH100`（Hopper）实现，再禁用 GSP 固件让源码补丁生效。这套对 GPU↔NIC 的 GPUDirect RDMA 是必要的。

但对 GDS **不需要**。原因是 GDS 走的是另一条路：

- GDS 的 nvidia-fs 调用的是 `nvidia_p2p_get_pages_persistent`（persistent API），它在 driver ≥ 555 时由 `nvfs-core.c` 直接选择；
- 该 API 在 pre-Blackwell 架构上原生返回 `SYS_NONCOH` aperture（走 `nvGpuOpsGetExternalAllocAperture`），**不需要** `_GH100` 的 BAR1 重定向；
- 唯一缺的是 `ThirdPartyP2P` 对象本身，而它可以从用户态用 RM ioctl 建出来。

所以：**用户态 hook 补 NV503C 对象即可，内核模块一个字节都不用改**。这也意味着不用重新编译内核模块、不用禁 GSP、不用冒掉显示/回滚的风险。

> 例外：如果你做的是 GPUDirect **RDMA**（GPU↔NIC，如 InfiniBand/RoCE 的 `ibv_reg_mr`），那才需要内核补丁那套。GDS（GPU↔NVMe）与 RDMA（GPU↔NIC）是两码事，别混淆。

---

## 踩坑与经验

1. **`gdscheck` 是假阳性来源**：`supports GDS` 只查能力位，不实际 pin page。真正的判据是 `/proc/driver/nvidia-fs/stats` 里的 `Bar1-map ok>0 err=0` + `Active Shadow-Buffer=0`。

2. **一个 VA space 只能绑一个 NV503C 对象**：多块 buffer 时，第二次 `REGISTER_VA_SPACE` 会被 RM 拒绝（`VA space register failed`）。正确做法是**只建一个 P2P 对象，每块显存用同一个对象做 `REGISTER_VIDMEM`**。这是最容易踩的坑。

3. **必须用 VMM API，不能用 `cudaMalloc`**：`REGISTER_VIDMEM` 需要 RM 内存对象句柄，只有 `cuMemCreate`/`cuMemMap` 会在 ioctl 流里暴露这个句柄（`cuMemCreate` 期间抓 `gd_memhandle`）。`cudaMalloc` 拿不到。

4. **ioctl hook 要进 `.dynsym`**：`extern "C" int ioctl(...)` 必须被动态链接器看到（用 `nm -D` 验证），否则 `dlsym(RTLD_NEXT)` 链不会真正拦截到 CUDA runtime 的 ioctl 调用。

5. **区分 `-22` 与 `-95`**：`EINVAL` 是门控拒绝（对象缺失，可补），`ENOTSUPP` 才是能力缺失（难补）。GeForce 是前者。

6. **显卡坞不是根因**：OCuLink/M.2 是被动式直通，不破坏 P2P（区别于主动式 Thunderbolt 坞）。GPU 与 NVMe 只要在同一 root complex 即可。
