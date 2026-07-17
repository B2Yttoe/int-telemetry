# INT-MC Completion Backends

本文档说明当前项目中并存的十种 INT-MC 补全后端，其中八种是单指标二维补全，另外两种是多指标联合张量补全。各方法不互相替换，均运行在 Ground OAM 侧，共用同一套 INT 采样、观测掩码、输出表结构和真值检验流程。

## 1. 方法列表

| 后端 | 类型 | 作用 |
|---|---|---|
| `prior-only` | 无学习结构先验基线 | 不运行矩阵学习，直接检验时间/轨道邻居和空间分组初始化本身的贡献。 |
| `low-rank` | 原始结构先验 + 低秩补全 | 保留当前项目已有的 INT-MC 方法，作为实验 3 的原始基线。 |
| `soft-impute` | 核范数类经典补全 | 采用奇异值软阈值收缩，抑制不稳定高阶成分。 |
| `kalman-smoother` | 离线状态空间时间基线 | 对每个对象的活动时间段执行局部水平 Kalman 滤波与 RTS 后向平滑。 |
| `graph-neighbor` | 非参数轨道图基线 | 只使用同时间片活动轨道图邻居做谐波式插值，不使用时间或低秩项。 |
| `graph-regularized` | 图时序正则补全 | 融合轨道图邻居、相邻时间片、结构先验和低秩目标。 |
| `st-gnn` | 研究规模单指标时空图补全 | 学习如何融合时间邻居、图邻居、轨道面/槽位结构和 INT 已观测样本。 |
| `costco` | 研究规模单指标张量/坐标补全 | 参考 CoSTCo 思想，使用节点/链路坐标嵌入、时间嵌入和潜在因子恢复缺失状态。 |
| `joint-cp` | 多指标三维张量补全 | 分别构造 `时间片×节点×节点指标` 和 `时间片×链路×链路指标` 张量，在二维低秩估计上做保守 CP 联合修正。 |
| `joint-cp-physics` | 联合张量补全 + 物理投影 | 在 `joint-cp` 后增加不读取真值的队列、缓存、电量、利用率和概率边界投影。 |

## 2. 调用方式

通过 `npm run int:experiment` 调用时，使用 `--int-mc-completion-backend` 选择后端：

```bash
npm run int:experiment -- --algorithm int-mc --int-mc-completion-backend prior-only
```

```bash
npm run int:experiment -- --algorithm int-mc --int-mc-completion-backend low-rank
```

```bash
npm run int:experiment -- --algorithm int-mc --int-mc-completion-backend soft-impute --int-mc-soft-impute-lambda-ratio 0.08
```

```bash
npm run int:experiment -- --algorithm int-mc --int-mc-completion-backend kalman-smoother --int-mc-kalman-process-variance 0.05 --int-mc-kalman-measurement-variance 0.1
```

```bash
npm run int:experiment -- --algorithm int-mc --int-mc-completion-backend graph-neighbor
```

```bash
npm run int:experiment -- --algorithm int-mc --int-mc-completion-backend graph-regularized --int-mc-graph-regularization-weight 0.4 --int-mc-temporal-regularization-weight 0.25
```

```bash
npm run int:experiment -- --algorithm int-mc --int-mc-completion-backend st-gnn
```

```bash
npm run int:experiment -- --algorithm int-mc --int-mc-completion-backend costco
```

```bash
npm run int:experiment -- --algorithm int-mc --int-mc-completion-backend joint-cp
```

```bash
npm run int:experiment -- --algorithm int-mc --int-mc-completion-backend joint-cp-physics
```

也可以直接调用重构器，只重跑 Ground OAM 的矩阵补全部分：

```bash
node stage2-int/tools/int-mc-reconstructor.mjs --input <stage1-truth-dir> --stage2 <stage2-int-dir> --ground <ground-probe-int-mc-dir> --completion-backend st-gnn
```

机器学习后端可选参数：

```bash
--ml-epochs 12
--ml-learning-rate 0.012
--ml-training-samples 12000
--ml-hidden-units 96
--ml-hidden-layers 2
--ml-latent-rank 64
```

通过完整实验入口调用时，对应参数为：

```bash
--int-mc-ml-epochs 48
--int-mc-ml-training-samples 50000
--int-mc-ml-hidden-units 128
--int-mc-ml-hidden-layers 3
--int-mc-ml-latent-rank 64
```

`prior-only`、`low-rank`、`soft-impute`、`kalman-smoother`、`graph-neighbor`、`graph-regularized`、`st-gnn` 和 `costco` 保持“单指标补全”口径，即每次对一个 `object x time` 二维矩阵建模。联合后端属于独立实验矩阵，不改写单指标结果。

经典/图正则后端可选参数：

```bash
--int-mc-soft-impute-lambda-ratio 0.08
--int-mc-kalman-process-variance 0.05
--int-mc-kalman-measurement-variance 0.1
--int-mc-kalman-initial-variance 1
--int-mc-graph-regularization-weight 0.4
--int-mc-temporal-regularization-weight 0.25
--int-mc-prior-regularization-weight 0.2
--int-mc-low-rank-regularization-weight 0.15
```

## 3. 共同边界

- 十种后端只使用已经送达 Ground OAM 的 INT 观测记录。
- 第一阶段隐藏的目标指标值只用于实验结束后的误差计算，不参与补全、训练或后端选择；节点/链路标识、轨道面/槽位和时间片等结构上下文对所有后端一致开放。
- 拓扑不可用的 `topology-down` 链路不会被补成可用链路。
- 输出仍为 `ground-mc-reconstructed-links.csv`、`ground-mc-reconstructed-nodes.csv`、`int-mc-link-errors.csv`、`int-mc-node-errors.csv` 和 `int-mc-evaluation.json`。
- 每行重构结果会记录 `int_mc_completion_backend`，用于区分来自哪一种补全后端。

## 4. 经典/确定性后端

`prior-only` 直接返回现有结构先验初始化矩阵，并锁定直接观测与 `topology-down` 单元。它不是性能目标，而是用于回答“没有后续补全模型时，先验本身能做到什么程度”。

`soft-impute` 使用核范数近端更新：

\[
X^{(k+1)}=P_\Omega(M)+P_{\Omega^c}\left(U\operatorname{diag}[(\sigma_i-\lambda)_+]V^\top\right).
\]

`kalman-smoother` 对每个连续活动时间段使用局部水平状态空间模型：

\[
x_t=x_{t-1}+w_t,\qquad y_t=x_t+v_t,
\]

其中 \(w_t\sim\mathcal{N}(0,Q)\)，\(v_t\sim\mathcal{N}(0,R)\)。前向 Kalman 滤波后执行 Rauch-Tung-Striebel 后向平滑。它会使用窗口内未来已经送达 Ground OAM 的观测，因此属于离线强基线，不能冒充严格在线因果算法。

`graph-neighbor` 在每个时间片独立执行活动轨道图插值：

\[
\hat x_{i,t}^{(k+1)}=
\frac{w_g\,|\mathcal N_t(i)|^{-1}\sum_{j\in\mathcal N_t(i)}\hat x_{j,t}^{(k)}+w_p x_{i,t}^{prior}}
{w_g+w_p}.
\]

它不使用相邻时间片和低秩目标，用于隔离“仅靠空间图结构能恢复多少状态”。

`graph-regularized` 近似求解：

\[
\min_X \|P_\Omega(X-M)\|_F^2+
\alpha\operatorname{tr}(X^\top L_GX)+
\beta\|XD_t\|_F^2+
\gamma\|X-X^{prior}\|_F^2+
\eta\|X-X^{lr}\|_F^2.
\]

这里的 `graph-regularized` 是完整的补全后端；配置中的 `orbit_graph_regularization` 是补全后的保守一致性后处理，两者不是同一个机制。

## 5. ST-GNN 后端

`st-gnn` 是研究规模单指标时空图机器学习补全器。它不再只做线性融合，而是把每个矩阵单元的估计写成“结构先验 + 非线性残差修正”：

\[
\hat{x}_{i,t}=x^{prior}_{i,t}+MLP_\theta(z_{i,t})
\]

其中：

- \(x^{prior}_{i,t}\)：原始结构先验初始化值；
- \(x^{temporal}_{i,t}\)：同一链路/节点相邻时间片的状态；
- \(x^{spatial}_{i,t}\)：同一时间片下轨道张量邻居的注意力聚合状态；
- \(\bar{x}_{i,*}\)：该行历史观测均值；
- \(\bar{x}_{*,t}\)：该时间片观测均值；
- \(c_i\)：轨道面、槽位、同轨/跨轨等结构特征。

特征向量 \(z_{i,t}\) 包含：

\[
z_{i,t}=[x^{prior}_{i,t},x_{i,t-1},x_{i,t+1},\Delta_t x_i,Agg_{\mathcal{N}(i)}(x_{\*,t}),\bar{x}_{i,*},\bar{x}_{*,t},density_i,density_t,c_i]
\]

其中 \(Agg_{\mathcal{N}(i)}\) 是按轨道结构相似度加权的邻居注意力聚合。当前实现使用送达的 INT 观测样本训练一个多层 `tanh` 残差 MLP，然后对 active-but-unobserved 的节点/链路状态做多轮消息传播式补全。

增强点：

- 时间侧加入前后时间片、时间斜率和时间波动幅度；
- 空间侧加入注意力加权邻居均值、邻居最小值、最大值和离散程度；
- 观测侧加入行/列观测密度，反映当前样本可信度；
- 模型侧从线性融合升级为可配置多层非线性残差 MLP；
- 预测侧采用残差形式，优先保持原结构先验稳定性，只学习修正量。
- 默认研究规模配置为 `hidden_units=96`、`hidden_layers=2`，实验中可扩大到 `128 x 3` 或更高。

## 6. CoSTCo 后端

`costco` 是研究规模单指标张量/坐标补全器。它把链路/节点 ID、时间片和轨道坐标映射到潜在空间：

\[
\hat{x}_{i,t}=b+\alpha_i+\beta_t+u_i^\top v_t+g_\theta(c_i,t)
\]

其中：

- \(u_i\)：链路或节点的潜在嵌入；
- \(v_t\)：时间片嵌入；
- \(\alpha_i,\beta_t\)：行/列偏置；
- \(g_\theta(c_i,t)\)：轨道坐标与时间坐标的可训练上下文项。

当前实现已经从轻量坐标线性项升级为“高秩潜在因子 + 非线性坐标 MLP”：

- 潜在秩默认不低于 32，可通过 `--ml-latent-rank` 或 `--int-mc-ml-latent-rank` 扩大；
- 坐标上下文项使用可配置多层 MLP；
- 时间坐标包含线性项、二次项与周期项；
- 轨道坐标与时间坐标加入交互特征。

该方法更适合做多时间片、多星座规模的单指标补全对比；多指标张量补全作为独立后端和独立实验矩阵运行，不混入八种单指标方法结果。

## 7. 实验 3 的建议比较

实验 3 建议固定相同的 INT 采样路径和采样率，只改变补全后端：

1. `prior-only`
2. `low-rank`
3. `soft-impute`
4. `kalman-smoother`
5. `graph-neighbor`
6. `graph-regularized`
7. `st-gnn`
8. `costco`

主要比较指标：

- 链路利用率 MAE / RMSE / P95 AE；
- 链路时延 MAE / RMSE / P95 AE；
- 节点 CPU MAE；
- 节点电量 MAE；
- 高拥塞链路识别 F1；
- 单位遥测字节有效重构精度；
- 小/中/大三种星座规模下的泛化表现。

## 8. 多指标联合 CP 后端

节点和链路不能放入同一个张量。当前实现分别建立：

\[
\mathcal{X}^{V}\in\mathbb{R}^{T\times N\times 5},\qquad
\mathcal{X}^{E}\in\mathbb{R}^{T\times L\times 8}.
\]

CP 预测为：

\[
\hat{x}_{t,o,m}=\mu_m+\sigma_m\sum_{r=1}^{R}A_{t,r}B_{o,r}C_{m,r}.
\]

各指标只使用直接观测值计算 \(\mu_m\) 和 \(\sigma_m\)。卫星编号只作为对象轴索引，不把 plane/slot 编号当成连续物理量乘加；类别型节点模式和链路状态不进入连续张量；`topology-down` 单元通过 active mask 排除。

联合预测不是直接替换二维结果，而是保守修正：

\[
w_{eff}=w\,q_m\sqrt{\rho}
\left(1+\frac{|\hat{x}_{CP}-\hat{x}_{2D}|}{\sigma_m}\right)^{-1}.
\]

其中 \(q_m\) 来自 CP 对直接观测的拟合质量，\(\rho\) 是观测密度。梯度、潜在因子和标准化预测均有统一数值边界；非有限预测回退二维估计。全部门控不读取隐藏真值。

`joint-cp-physics` 进一步投影以下约束：

- `cache_used_mb >= queued_traffic_mb`；
- 正队列对应正排队流量；
- 相邻推断片电量变化不超过配置门限；
- 利用率不低于路由流量与重构容量给出的负载下限；
- 正排队流量对应正排队时延；
- `packet_error_rate` 保持在 `[0,1]`。

公平对照入口：

```bash
npm run experiment3:joint-tensor
```

紧凑正式结果位于 `reports/experiment3-joint-tensor-completion/`。当前 48 片结果表明：纯联合 CP 与二维低秩基本持平，尚不能声称普遍降低误差；物理投影能消除已定义的一致性违反，并在中、大星座降低宏误差，但该收益必须与 CP 本身分开归因。
