---
title: PPA的精打细算：NVIDIA 3nm Die-to-Die Link架构解析
date: 2026-07-07
tags:
  - 半导体
  - NVIDIA
  - Die-to-Die
  - D2D
  - 先进封装
  - 3nm
  - Chiplet
mathjax: true
---

## 引言

Chiplet时代，Die-to-Die (D2D) 互连已经从一个学术课题变成了决定芯片系统能否成功的生命线。GPU要连HBM，CPU要连IO Die，逻辑Die要叠逻辑Die——每一对Die之间都有一条D2D link在默默搬运数据，而这条link的PPA（Performance, Power, Area）直接决定了系统的能效底线。

2025年VLSI Symposium和2026年4月的IEEE JSSC上，NVIDIA的Brian Zimmer团队发表了他们在3nm工艺上实现的D2D互连接口[^jssc]。这篇工作的核心数据令人印象深刻：**77 fJ/bit的能耗效率**、8 Gbps/pin的带宽、以及44 Tbps/mm²的带宽密度。但它真正值得关注的不是某个单项指标的极致，而是它背后的PPA权衡哲学——在Chiplet互连这个战场上，什么该追求极致，什么该寻找平衡。

本文基于论文摘要及公开信息，对这一工作的技术亮点进行解析。

[^jssc]: B. Zimmer, S. G. Tell, and T. Gray, "A 77-fJ/bit 8-Gbps Adaptive-Voltage-Compatible Self-Timed Die-to-Die Link for 2.5-D and 3-D Interconnect in 3 nm," IEEE J. Solid-State Circuits, vol. 61, no. 4, Apr. 2026. DOI: [10.1109/JSSC.2026.3658215](https://ieeexplore.ieee.org/abstract/document/11372923)

## 先交代语境：NVLink-C2C的双面战线

要理解这篇工作的定位，先得看NVIDIA在D2D领域已有的旗舰技术——NVLink-C2C。

NVLink-C2C（Chip-to-Chip）是NVIDIA为GPU到GPU互连设计的D2D接口，关键指标是**40 Gbps/pin**的速率，配合高密度micro-bump，实现了极高的跨Die通信带宽。这个指标代表的是"性能优先"的技术路线——当两颗GPU Die需要通过硅中介层交换海量数据时（比如Grace Hopper架构中Grace CPU Die与Hopper GPU Die），每pin的速率越高越好，因为中介层的布线资源是有限的。

但NVLink-C2C并非万能。40 Gbps/pin的代价是更高的每bit能耗和更严格的时钟/信号完整性要求。在GPU到HBM的互连、低功耗逻辑Die到逻辑Die的通信、或者3D垂直堆叠（face-to-face bonding）场景下，能效比（Energy Efficiency）往往比绝对速率更重要。

这就是今天这篇论文的定位：**在能效维度上做到极致，构建NVIDIA D2D技术路线的另一面。**

## 77 fJ/bit：能效极致意味着什么

77飞焦耳每比特（fJ/bit）。这个数字放在什么位置？

一个简单的参照：在DDR5的主机接口中，每bit能耗通常在数百fJ到数pJ量级；NVLink-C2C在40 Gbps/pin下的每bit能耗远高于77 fJ/bit（虽然论文未公开具体数字，但从功耗-速率关系可以推断）。77 fJ/bit意味着传输10^{12} bit（125 GB）只需要77 mJ——不到手机屏幕亮一秒的功耗。

在Chiplet系统中，D2D link的功耗是"固定开销"——无论你在做矩阵乘法还是做内存拷贝，Die间的数据搬运都在消耗能量。所以这个固定开销越低，系统的整体能效天花板就越高。尤其是在AI训练和推理场景中，模型并行（Model Parallelism）需要频繁在Die之间交换激活值和梯度，D2D能效直接影响FLOPS/Watt的最终表现。

**PPA三角的Power角被按到了地板上。**

## Self-Timed架构：告别全局时钟树

传统的高速D2D接口通常采用源同步（Source-Synchronous）时钟方案——发送端同时发送数据和时钟，接收端用这个 forwarded clock 来采样数据。这种方案成熟可靠，但有一个根本性的约束：时钟偏移（Clock Skew）限制了速率的上限，同时也限制了电压调节的灵活性。

这篇论文采用了**自定时（Self-Timed）**架构，核心思路是使用标准自适应数字时钟和电压供电，而不是依赖精心设计的全局时钟树。[^inferred]

[^inferred]: 基于论文摘要推断——"standard adaptive digital clock and voltage supply"

这个选择背后的PPA考量是多层次的：

**性能层面**，Self-Timed设计可以实现**1个时钟周期的链路延迟**（link latency）。这意味着从发送端发起传输到接收端完成采样，只需要一个时钟周期。对于需要频繁进行小数据量Die间通信的场景（比如分布式缓存一致性协议的Probe/Response），低延迟比高带宽更重要。

**功耗层面**，Self-Timed架构天然适合DVFS（Dynamic Voltage and Frequency Scaling）。因为不需要维持严格的时钟偏移预算，电压和频率可以在更宽的范围内动态调节。当系统负载降低时，可以更激进地下压电压而不破坏链路可靠性——这对GPU这种负载波动剧烈的芯片来说至关重要。

**面积层面**，省去了传统源同步方案中用于时钟偏移补偿的延迟线和校准电路，节约了每个TX/RX通道的面积开销。面积效率在D2D link中特别重要，因为中介层（interposer）上的布线密度决定了能放置多少个信号通道。

## 4-bit序列化：每pin榨取4倍带宽

每pin序列化4个数据bit（4-bit serialization）。[^inferred]

[^inferred]: 基于论文摘要推断——"four data bits serialized per pin"

这个设计选择的本质是**在pin带宽和电路复杂度之间找平衡**。每pin只传1 bit（NRZ）是最简单的方案，但pin是中介层上最宝贵的资源——增加pin意味着增加micro-bump、增加布线宽度、增加中介层成本。每pin 4-bit序列化意味着同样的pin数量可以获得4倍带宽，或者用1/4的pin达到同样的带宽。

代价是什么？是TX端的并行转串行（Parallel-to-Serial）电路和RX端的时钟数据恢复（CDR）电路的复杂度增加。但在3nm工艺下，晶体管速度足够快，这个复杂度的代价在可接受范围内，换来的是中介层面积的大幅节约。

**44 Tbps/mm²的带宽密度**就是这一设计决策的直接体现。在0.7V标称电压下，每平方毫米的中介层面积可以承载44 Tbps的双向互连带宽。这个数字的意义在于：对于CoWoS封装的GPU+HBM系统，中介层面积是整个封装成本的大头（CoWoS的中介层是整片硅晶圆切割的）。带宽密度越高，同样的互连带宽需求需要的中介层面积越小，封装成本越低。

## 2.5D与3D：一条链路适配两种封装范式

论文明确指出这条D2D link同时适用于2.5D（硅中介层上的side-by-side互连）和3D（垂直堆叠的face-to-face互连）场景。[^inferred]

[^inferred]: 基于论文摘要推断

这在技术上有两层含义：

1. **电气特性兼容**：2.5D场景中信号通过硅中介层的微米级布线传输，线长可能达数毫米，信道特性是传统的RC或传输线行为。3D场景中信号通过TSV和face-to-face micro-bump传输，线长极短，但寄生参数和噪声环境不同。一条链路能同时适应两种场景，说明其接收端的均衡（Equalization）和判决电路有足够的鲁棒性裕量。

2. **设计复用**：对于NVIDIA这样的芯片巨头，同一套D2D IP可以复用在不同的封装形态中，降低了设计成本和验证周期。Blackwell架构中已经出现了3D堆叠的GPU Die（B200的two-die stack），未来可能会有更复杂的3D拓扑，一套通用的D2D link IP意义重大。

## PPA三角的全景视角

让我们把这条D2D link的PPA三角画出来：

| 维度 | 指标 | 评价 |
|------|------|------|
| **Performance** | 8 Gbps/pin, 1 cycle latency | 速率中规中矩，延迟极优 |
| **Power** | 77 fJ/bit @ 0.7V | 同类最优水平 |
| **Area** | 44 Tbps/mm² 带宽密度 | 极高，有效节约中介层面积 |

这不是一个在某个维度上破纪录的设计——8 Gbps/pin在今天的高速串行链路中并不算快。但它是一个**每个维度都在合理位置、整体PPA最优**的设计。

这正是先进芯片设计中最难的艺术：PPA三角不是三维空间中的自由优化，而是一条约束曲线——你要在一个维度上多走一步，就得在另一个维度上退一步。NVIDIA这条D2D link选择的策略是：**在速率上不逞强，把能效和面积效率推到极致**。因为在Chiplet系统的全局视角下，D2D link是基础设施而非性能瓶颈——它的职责是尽可能高效地搬运数据，而不是成为系统的性能名片。

## 测试芯片设计

论文提到的测试芯片（test chip）采用了side-by-side的TX/RX宏布局，通过片上连线互连而非实际的封装互连。[^inferred]

[^inferred]: 基于论文摘要推断——"test chip with side-by-side TX/RX macros interconnected with on-chip wiring"

这是D2D链路论文中的标准验证方式：在单芯片上模拟Die-to-Die的电气环境（通过片上走线模拟中介层布线的电气特性），验证TX/RX的功能和PPA指标。后续如果需要实际封装验证，通常会再做一次chip-on-wafer或multi-die的封装测试。

3nm工艺意味着这是目前已公开的工艺节点最先进的D2D link之一。3nm带来的优势是更快的晶体管切换速度和更低的动态功耗，但也带来了更复杂的物理设计挑战（更细的金属间距、更高的布线RC、更多的工艺变异）。

## 与行业对比：D2D link的竞争格局

虽然这篇论文聚焦能效维度，但把它放在整个D2D link的行业版图中看，会有更清晰的认识：

- **AMD Infinity Fabric**：AMD在Chiplet互连领域深耕多年，Infinity Fabric的演进方向与NVLink-C2C类似，追求高带宽。AMD的最新封装互连也达到了数十Gbps/pin的水平。
- **Intel EMIB/Die-to-Die接口**：Intel的Embedded Multi-die Interconnect Bridge本质上也是一种2.5D互连，配合高密度互连实现了类似的中介层功能。Intel的D2D接口在能效方面也在持续优化。
- **UCIe标准**：Universal Chiplet Interconnect Express试图建立D2D互连的行业标准。UCIe支持多种速率模式，其设计理念也是让不同的Chiplet厂商能够在标准化的物理层上互联互通。

NVIDIA的这篇工作在UCIe等标准之外，展示了一个高度定制化的、面向自身产品需求的D2D link实现。这也反映了一个行业现实：在性能敏感的高端芯片领域，通用标准的速率往往落后于定制化实现。

## 结语：基础设施的价值

77 fJ/bit、8 Gbps/pin、44 Tbps/mm²、1 cycle latency。

单独看这些数字，没有一个让人拍案叫绝。但把它们组合在一起，放在Chiplet系统的全局视角下，这就是一个精心雕琢的基础设施级设计。

在AI芯片的叙事中，人们总是把目光投向计算核心——矩阵单元的FLOPS、Tensor Core的新特性、SRAM的容量。但D2D互连是这些光芒背后的管道。当两个Die需要每秒交换TB级别的数据时，管道的能效直接决定了系统的FLOPS/Watt能兑现多少。

NVIDIA这条3nm D2D link传达的信号很明确：在Chiplet时代，最聪明的PPA策略不是在某个维度上死磕极致，而是找到那个最适合系统全局最优的平衡点。对能效的极致追求，有时候比对速率的极致追求更能打动系统架构师。

---

**原始论文：**

> B. Zimmer, S. G. Tell, and T. Gray, "A 77-fJ/bit 8-Gbps Adaptive-Voltage-Compatible Self-Timed Die-to-Die Link for 2.5-D and 3-D Interconnect in 3 nm," *IEEE Journal of Solid-State Circuits*, vol. 61, no. 4, Apr. 2026.
>
> IEEE Xplore: [https://ieeexplore.ieee.org/abstract/document/11372923](https://ieeexplore.ieee.org/abstract/document/11372923)
>
> DOI: 10.1109/JSSC.2026.3658215
