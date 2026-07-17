# 实验 3 多方法矩阵补全设计

## 目标

在不改变第一阶段真值、INT probe 路径、hop/report 或 Ground OAM 直接观测的前提下，把实验 3 从三种补全器扩展为六种互补方法，公平比较单指标节点 CPU 矩阵 `node_id x time_slice` 的缺失值恢复能力。

## 方法矩阵

| 后端 | 方法类别 | 作用 |
|---|---|---|
| `prior-only` | 无学习弱基线 | 直接使用现有时间、轨道邻居和空间分组初始化值，量化“先验本身”能恢复多少 |
| `low-rank` | 现有 INT-MC 基线 | 保留原有迭代低秩投影，保证历史实验可比 |
| `soft-impute` | 经典核范数类补全 | 对奇异值做软阈值收缩，抑制过拟合和不稳定高阶成分 |
| `graph-regularized` | 图正则补全 | 联合轨道邻居平滑、时间连续性、低秩目标和初始化先验 |
| `st-gnn` | 图时序机器学习 | 保留现有图消息传递与时间残差模型 |
| `costco` | 坐标张量机器学习 | 保留现有坐标嵌入和非线性张量补全模型 |

`prior-only`、`soft-impute` 和 `graph-regularized` 作为独立后端加入，不替换现有方法。

## 公平性约束

1. 同一星座的六种方法必须读取完全相同的 `ground-reconstructed-nodes.csv`。
2. 同一星座的六种方法必须共享 probe plan、hop/report 和直接观测掩码。
3. 直接观测位置必须锁定，任何补全器都不得修改。
4. 第一阶段隐藏的 CPU 目标值只用于生成最终误差报告，不得进入后端训练、参数选择或方法选择；节点标识、轨道面/槽位和时间片等结构上下文对所有后端一致开放。
5. 本轮保持 CPU 单指标，避免把多指标耦合收益混入补全算法对比。
6. 现有 `low-rank` 输出语义保持不变。

实验产物记录 Ground OAM 输入、probe plan 和观测掩码的 SHA-256 指纹，以机器可核验方式证明输入一致。

## 新方法数学定义

### Prior-only

令 `X^(0)` 为现有可观测时间邻居、轨道张量邻居和空间分组统计产生的初始化矩阵，直接令：

\[
\hat X = X^{(0)}, \qquad P_\Omega(\hat X)=P_\Omega(X).
\]

### Soft-Impute

在每轮对当前矩阵执行软阈值奇异值收缩：

\[
X^{(k+1)} = P_\Omega(X)+P_{\Omega^c}
\left(U\operatorname{diag}[(\sigma_i-\lambda)_+]V^\top\right).
\]

`topology-down` 位置由 active mask 固定为零，观测位置每轮重新锁定。

### Graph-regularized

图正则后端近似最小化：

\[
\|P_\Omega(X-M)\|_F^2+
\alpha\operatorname{tr}(X^\top L_GX)+
\beta\|XD_t\|_F^2+
\gamma\|X-X^{(0)}\|_F^2+
\eta\|X-X_{lr}\|_F^2.
\]

实现采用稳定的 Jacobi 迭代：缺失位置由同片轨道图邻居、相邻时间片、先验初始化和软阈值低秩目标的加权平均更新；观测值和 active mask 每轮锁定。

## 实验输出

- 六方法总体与 inferred-only `MAE / RMSE / P95 AE / max AE / sMAPE / R2 / within-5 / within-10`。
- 每种方法的补全墙钟时间、迭代次数、有效秩或正则权重、参数量。
- 每星座输入指纹和公平性审计结果。
- 误差图、尾部误差图、计算成本图、逐时间片图和完整 CSV/JSON/HTML。

## 验证策略

先用合成小矩阵单元测试证明软阈值、观测锁定、active-mask 和图平滑行为；再用现有实验 3 的 Ground OAM 输入运行短切片烟测。只有轻量验证通过后，才复用既有 48 时间片观测产物运行新增后端，不重新执行第一阶段、路径规划或逐跳 INT 全流程。
