# 拓扑版本化风险感知主动遥测

## 1. 三层边界

正式方法把系统分为三层：

1. 环境约束层：活动链路掩码、极区、距离、天线、能量和星地回传可行性；
2. 主动遥测层：拓扑版本、风险、不确定性、边际信息收益和硬字节预算；
3. OAM 重构层：低秩补全、轨道先验、节点链路耦合和电量物理投影。

论文主算法对应第二层。第三层只消费观测结果，不参与 probe 路径的可行性判断；第一阶段真值只在运行结束后评价误差。

## 2. 拓扑版本

时间片 \(t\) 的预测活动拓扑为：

\[
\hat G_t=(V_t,E_t)
\]

拓扑版本写为：

\[
\nu_t=(c_t,h_t,\Delta E_t,\tau_t)
\]

- \(c_t\)：可复用计划库的拓扑类别；
- \(h_t\)：当前活动边集合的精确签名；
- \(\Delta E_t\)：相对上一片新增和断开的链路；
- \(\tau_t\)：距下一次显著拓扑变化的预测时间。

选择器先进行低成本模式预筛选，再只展开一种规划模式：精确版本匹配使用 `reuse`，高置信小范围边变化使用 `repair`，无缓存、OAM 要求全局重规划或版本不确定时使用 `fresh`。这避免在每个时间片同时展开三套候选池。

`repair` 采用固定容量的缓存池，不允许连续时间片因无效路径而逐步萎缩，也不追加路径突破候选预算。每片保留约三分之二的合法缓存路径，其余位置由变化链路、OAM 必测目标和当前轨道代表路径补位。失效缓存路径直接淘汰，不再逐条执行最短路 reroute；这样局部修复表示“预算内替换路径”，而不是在旧路径上进行昂贵的全图搜索。

`reuse` 和 `repair` 使用缓存计划静态排序加单次边际验证，`fresh` 才执行完整懒惰贪心。所有模式仍使用同一硬字节预算和同一信息价值定义，因此快速验证不会绕过预算或观测质量约束。

## 3. 不确定性与风险

对节点或链路对象 \(o\) 定义：

\[
U_t(o)=w_1\sigma_t^2(o)+w_2\operatorname{AoI}_t(o)+w_3D_t(o)+w_4C_t(o)
\]

当前实现只使用严格因果的 Ground OAM 和可预测轨道信息：

- 预测方差由历史波动、低秩杠杆和 OAM 置信度构成；
- AoI 取本地最近观测年龄与 OAM 上报年龄的较大值；
- 模型分歧在尚无多模型方差时由 OAM 置信度下降近似；
- 报告冲突直接使用 `conflict_severity`。

风险为：

\[
R_t(o)=r_1P_{down}(o)+r_2P_{polar}(o)+r_3P_{report\ failure}(o)+r_4P_{transition}(o)
\]

这些量来自滚动接触预测、极区限制、回传窗口和拓扑漂移。风险项必须是正收益：对象越可能即将失去观测机会，当前探测价值越高。

## 4. 路径与 metadata 联合动作

一个候选动作写成：

\[
a=(p,m)
\]

其中 \(p\) 是 probe 路径，\(m\) 是 `full`、`compact` 或逐跳 `selective` metadata。`selective` 会生成可执行的 hop mask；不需要采集的中继节点按 `forward-only` 转发，不写入 INT metadata。

在已选动作集合 \(S\) 下，边际价值为：

\[
\Delta V_t(a\mid S)=
\sum_{o\in Obs(a)\setminus Obs(S)}q_m(o)U_t(o)
+\alpha\sum_{o\in Obs(a)\setminus Obs(S)}q_m(o)U_t(o)R_t(o)
-\gamma\operatorname{Redundancy}(a,S)
\]

这里风险项使用加号。若写成减号，就会错误地压低即将断链对象的采样优先级。

## 5. 硬预算贪心

字节预算是约束而不是可被收益抵消的软惩罚：

\[
\sum_{a\in S_t}C_{bytes}(a)\le B_t
\]

每轮选择单位字节边际价值最高的动作：

\[
a^*=\arg\max_{a\notin S_t}
\frac{\Delta V_t(a\mid S_t)}{C_{bytes}(a)}
\]

只要候选动作不能放入剩余预算，就不会被选择。OAM、风险、覆盖目标和 critical 标记只能改变预算内优先级，不能越过 \(B_t\)。

三种规划模式分别在相同预算下求解，再比较：

\[
J_t(z)=\sum_{a\in S_t^z}\Delta V_t(a)-\lambda_p C_{planning}(z,\nu_t)
\]

\[
z_t^*=\arg\max_{z\in\{reuse,repair,fresh\}}J_t(z)
\]

规划成本满足：

\[
C_{planning}(reuse)<C_{planning}(repair)<C_{planning}(fresh)
\]

## 6. 正式入口

路径选择器的正式配置为：

```text
--planner topology-versioned-risk-int
--telemetry-byte-budget <bytes-per-slice>
--risk-weight 0.35
--redundancy-weight 0.30
--planning-cost-weight 0.05
--prediction-horizon 4
```

实验消融使用两个内部参数：

```text
--planner-modes fresh
--information-gain-mode coverage-only
--metadata-actions full
```

它们不属于正式公开参数，只用于分别删除拓扑版本、边际信息或可变 metadata。

## 7. 审计输出

`probe-paths-int-mc.csv` 记录每个动作的：

- 规划模式与 metadata 动作；
- 观测节点和链路集合；
- 边际信息、风险、冗余和收益/字节；
- 逐跳 selective metadata plan 与 forward-only 数量；
- 选择后预算使用量和剩余量。

`probe-summary-int-mc.csv` 和 `probe-coverage-int-mc.json` 汇总：

- `reuse/repair/fresh` 时间片数；
- `full/compact/selective` 动作数；
- forward-only 跳数；
- 硬预算越界次数；
- 规划目标、信息收益和风险收益；
- 模式预筛选次数、规划候选数、边际评分次数和缓存重算次数。

48 时间片机制消融报告位于 `reports/experiment12-topology-reuse-contribution-48slice-stress00`。其中 Telesat 351 未触发复用或修复，只能作为适用边界；Starlink 1584 在 16 个时间片触发局部修复。规划墙钟的重复计时单独保存在 `planner-benchmark/PLANNER_BENCHMARK.md`，避免用单次整条流水线时间代替算法复杂度证据。

`--topology-versioned-objective` 仍保留为历史实验的旧式保守排序微调。新正式方法只由 `--planner topology-versioned-risk-int` 启用，两者不应在论文主实验中混用。
