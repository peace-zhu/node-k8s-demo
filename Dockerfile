# ============================================================================
# 最小 Node 服务镜像
# ============================================================================
# 构建： docker build -t node-k8s-demo:v1 .
# 运行： docker run -d -p 38090:3000 --name demo node-k8s-demo:v1
# ============================================================================

# ① 底座：官方 Node 18 + alpine 精简 Linux（约 45MB）
#    ⚠️ alpine 用的是 musl libc，如果有 bcrypt / sharp / canvas 这类原生模块，
#       编译可能失败 —— 那时换成 node:18-slim 或其他版本
FROM node:18-alpine

# ② 工作目录：之后所有命令都在容器内的 /app 下执行
#    目录不存在会自动创建
WORKDIR /app

# ③ 先只拷"依赖清单"（不拷源码）
#    这样只要依赖没变，下面的安装层就能一直被缓存复用
COPY package*.json ./

# ④ 安装依赖
#    ⚠️ 本项目零依赖，所以这一行先注释掉。
#       等你加了 dependencies 之后把它取消注释 —— 它是标准的"先装依赖再拷源码"写法。
# RUN npm install --omit=dev

# ⑤ 最后才拷源码（源码改得最勤，放最上面，避免连累上面的缓存）
COPY app.js ./

# ⑥ 镜像内的默认环境变量（这些是「默认值」，运行时可以用 -e 或 ConfigMap 覆盖）
ENV NODE_ENV=production
ENV PORT=3000

# ⑦ 声明容器对外使用 3000 端口
#    ⚠️ 这只是"写进说明书"，真正把端口开放出来靠 docker run -p 或 K8s Service
EXPOSE 3000

# ⑧ 切换成非 root 用户运行（node:18-alpine 镜像自带 node 用户）
#    🔴 生产红线：默认 root 运行风险大 —— 容器被攻破就等于拿到 root
#    注意：有状态目录（需要写的）要额外 chown，见下面注释
# USER node

# ⑨ 容器启动时执行的命令
#    ⚠️ 必须用 exec 形式（JSON 数组）。写成 CMD node app.js 会多套一层 shell，
#       K8s 发停止信号时应用收不到 → 停机会卡到超时被强杀，优雅停机失效
CMD ["node", "app.js"]
