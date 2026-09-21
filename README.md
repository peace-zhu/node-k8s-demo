# node-k8s-demo

> 一个**最小可运行**的 Node.js 服务，附带完整的 Kubernetes 清单。
> 用途：作为长期复用的 **K8s 测试/联调样板** —— 练命令、验证配置、对照学习都用它。
>
> 特点：**零依赖**（只用 Node 自带的 `http` 模块）→ 构建快、不受网络与镜像源影响、不会踩原生模块编译的坑。

---

## 目录结构

```
node-k8s-demo/
├── app.js                 # 服务本体（零依赖，约 120 行，注释详尽）
├── package.json           # 无 dependencies
├── Dockerfile             # 多步注释：为什么要先拷清单、为什么 CMD 用数组形式
├── .dockerignore          # 🔴 关键：挡住 .env / node_modules / k8s 清单
├── .gitignore
├── k8s/
│   ├── configmap.yaml     # 配置外置：环境标识、问候语
│   ├── deployment.yaml    # 2 副本 + 探针 + 滚动更新策略 + （注释掉的）资源限制
│   └── service.yaml       # NodePort 30081 → 容器 3000
└── README.md
```

---

## 快速开始

### 前提

- 已有一个 K8s 集群（本项目按 **kind** 写的，集群名 `k8s-lab`）
- 已配好 kubectl

### 三步跑起来

```bash
# ① 构建镜像（在项目根目录执行，最后那个 . 是构建上下文）
docker build -t node-k8s-demo:v1 .

# ② 把镜像装进 kind 集群（kind 的节点看不到宿主机 Docker 的镜像）
kind load docker-image node-k8s-demo:v1 --name k8s-lab

# ③ 提交声明
kubectl apply -f k8s/
```

### 验证

```bash
kubectl get deploy,rs,pod
kubectl get svc node-k8s-demo-svc
```

期望：`READY 2/2`，Service 的 `PORT(S)` 显示 `80:30081/TCP`。

### 访问

```bash
# 节点 IP 用这条查
kubectl get nodes -o wide

# 然后访问（把 172.20.0.2 换成你查到的）
curl http://172.20.0.2:30081
```

多刷几次 —— `hostname` 字段会在两个 Pod 之间轮换，**这就是 Service 的负载均衡**。

---

## 接口

| 路径 | 用途 |
|---|---|
| `GET /` | 返回实例信息：`message` / `appEnv` / `hostname`（= Pod 名）/ `pid` / 时间 |
| `GET /healthz` | **存活探针**用，只回答"我还活着" |
| `GET /readyz` | **就绪探针**用，回答"我能接请求了" |
| `GET /env` | 看环境变量注入了什么（**教学/排障用，生产建议去掉**） |

---

## 配置怎么改

配置**不在镜像里**，在 `k8s/configmap.yaml`：

```yaml
data:
  APP_ENV: "test"
  GREETING: "你好"
```

改完要重启 Pod 才生效（K8s 不会自动让运行中的 Pod 重读 ConfigMap）：

```bash
kubectl edit configmap node-k8s-demo-config
kubectl rollout restart deploy/node-k8s-demo
```

> 这就是"**同一份镜像 + 不同配置 = 不同环境**"的做法。
> test / UAT / prod 用同一个镜像，靠各自的 ConfigMap 区分。

---

## 常用命令

```bash
# 查看
kubectl get deploy,rs,pod -o wide
kubectl describe pod <pod名>          # 看 Events（排障第一步）

# 日志（多副本时按标签看全部）
kubectl logs -l app=node-k8s-demo --tail=50 -f

# 进容器
kubectl exec -it <pod名> -- sh

# 改副本数（注意：只改集群里的对象，没改磁盘上的 yaml）
kubectl scale deploy/node-k8s-demo --replicas=4

# 滚动更新 + 回滚
kubectl set image deploy/node-k8s-demo app=node-k8s-demo:v2
kubectl rollout status deploy/node-k8s-demo
kubectl rollout history deploy/node-k8s-demo
kubectl rollout undo deploy/node-k8s-demo

# 清理
kubectl delete -f k8s/
```

---

## 可以拿它做的实验

| 实验 | 怎么做 | 会看到什么 |
|---|---|---|
| **自愈** | `kubectl delete pod <某个>` | 自动补一个新 Pod（新名字 + 新 IP） |
| **负载均衡** | 连续 `curl` 首页 | `hostname` 在不同 Pod 间轮换 |
| **零停机升级** | 改镜像版本 `apply`，同时后台持续 curl | 全程 200，一次不断 |
| **零停机验证探针的必要性** | 把 `readinessProbe` 删掉再升级 | 可能出现短暂 502（新 Pod 还没就绪就被加进列表） |
| **配置注入** | 改 ConfigMap 里的 `GREETING` + 重启 | 首页的 `message` 变了，**镜像一个字没改** |
| **标签是认领纽带** | `kubectl label pod <某个> app=changed --overwrite` | 它掉出 Endpoints，同时 ReplicaSet 会补一个新 Pod |
| **升级中断型策略** | 把 `strategy.type` 改成 `Recreate` | 会出现一段完全无服务的窗口（对比 RollingUpdate） |

---

## 这个项目刻意体现的生产要点

| 要点 | 在哪 |
|---|---|
| 配置外置，不烧进镜像 | `k8s/configmap.yaml` + `envFrom` |
| 应用监听 `0.0.0.0` 而非 `127.0.0.1` | `app.js` 的 `HOST` |
| `CMD` 用 exec 数组形式（信号能传到应用） | `Dockerfile` |
| 优雅停机（处理 SIGTERM） | `app.js` 末尾 |
| `.dockerignore` 挡住 `.env` | `.dockerignore` |
| 就绪/存活探针分离 | `k8s/deployment.yaml` |
| `maxUnavailable: 0` 实现零停机 | `k8s/deployment.yaml` |
| 不用 `latest` 标签 | 镜像一律 `:v1` `:v2` |
| `imagePullPolicy: IfNotPresent` | 避免强制联网拉取 |
| 资源限制 | `deployment.yaml` 里**已注释**（阶段 6 讲完再打开） |

---

## 待补充（学到对应阶段再打开）

- [ ] `resources.requests/limits` —— 资源限制（阶段 6）
- [ ] `securityContext` + `USER node`（非 root 运行）（阶段 6）
- [ ] `Secret` 存放密码类配置（阶段 4）
- [ ] `Ingress` 替代 NodePort 对外暴露 + HTTPS 证书（阶段 4）
- [ ] `PersistentVolumeClaim` 挂载持久化数据（阶段 4）
- [ ] `HPA` 按 CPU 自动扩缩容（进阶）
- [ ] `NetworkPolicy` 网络访问控制（阶段 6）

---

## 本地直接跑（不用 Docker）

```bash
APP_ENV=local GREETING=嗨 node app.js
# 然后 curl http://localhost:3000
```

---

## License

MIT
