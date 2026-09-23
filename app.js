'use strict';
// ============================================================================
// 最小可运行的 Node.js 服务（零依赖，只用 Node 自带的 http 模块）
// ============================================================================
//
// 【为什么用零依赖】
//   1. 不需要 npm install → 构建镜像快，不受网络/镜像源影响
//   2. 不会遇到"alpine 的 musl 库编译原生模块失败"这类坑
//      （bcrypt / sharp / canvas 这类东西在 alpine 上常炸，生产很常见）
//
// 【配置全部来自环境变量】—— 这就是"配置外置、运行时注入"
//   镜像里不烧任何环境相关的值；test / UAT / prod 用同一个镜像，靠启动时注入不同的值区分。
//   K8s 里注入的方式是 ConfigMap / Secret（见 k8s/configmap.yaml）。
// ============================================================================

const http = require('http');
const os = require('os');

// ---------- 读配置：全部来自环境变量，每一项都给一个默认值 ----------
const PORT = parseInt(process.env.PORT || '3000', 10); // 监听端口
const HOST = process.env.HOST || '0.0.0.0';            // ★ 必须 0.0.0.0，否则容器外访问不到
const APP_ENV = process.env.APP_ENV || 'local';        // 环境标识：local / test / uat / prod
const GREETING = process.env.GREETING || '你好';       // 一句问候语，用来看 ConfigMap 有没有生效

const startedAt = new Date();

// 只允许通过 /env 暴露这些键的值（避免不小心把密码、token 打印出去）
const EXPOSABLE_KEYS = ['PORT', 'HOST', 'APP_ENV', 'GREETING', 'NODE_ENV', 'POD_NAME', 'POD_IP'];

// ---------- 工具函数：统一返回 JSON ----------
function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2); // 缩进 2 空格，方便人眼读
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// ---------- 路由表 ----------
const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0]; // 去掉查询串，只看路径

  // ① 存活探针：只回答"我还活着吗"，不检查任何依赖
  //    对应 K8s 的 livenessProbe（见 k8s/deployment.yaml）
  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('ok\n');
  }

  // ② 就绪探针：回答"我能接请求了吗"
  //    真实项目里这里应该检查数据库连接、缓存连接等依赖是否就绪
  //    对应 K8s 的 readinessProbe —— ★ 它决定了 Pod 会不会被加进 Service 的后端列表 ★
  if (path === '/readyz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('ok\n');
  }

  // ③ 首页：把当前实例的身份信息打出来，方便观察负载均衡
  if (path === '/') {
    return sendJson(res, 200, {
      message: `${GREETING}，我是跑在容器里的 Node 服务（v1）`,
      // ★ 本次发布新增的字段：一眼看出"这一份代码是哪个版本"
      //   它和镜像 tag（v2）、git commit 一起构成"版本三要素"
      release: 'v2-2026-09-22',
      appEnv: APP_ENV,
      // ★ hostname 在 K8s 里默认等于 Pod 名字
      //   所以你多刷几次，就能看到请求被分到了不同 Pod —— 这就是 Service 的负载均衡
      hostname: os.hostname(),
      pid: process.pid, // 在容器里通常是 1 —— 它就是容器的 1 号进程（CMD 启动的那个）
      nodeVersion: process.version,
      startedAt: startedAt.toISOString(),
      now: new Date().toISOString(),
      requestFrom: req.socket.remoteAddress, // 请求从哪个地址来的
    });
  }

  // ④ /env：看看环境变量到底注入了什么（教学/排障用，生产环境建议关掉）
  if (path === '/env') {
    const values = {};
    EXPOSABLE_KEYS.forEach((k) => {
      if (process.env[k] !== undefined) values[k] = process.env[k];
    });
    return sendJson(res, 200, {
      // 所有环境变量的「键名」（不含值，避免泄露）
      allKeys: Object.keys(process.env).sort(),
      // 白名单键的「值」
      values,
    });
  }

  // ⑤ 其他路径一律 404
  return sendJson(res, 404, { error: 'not found', path });
});

// ---------- 启动 ----------
server.listen(PORT, HOST, () => {
  console.log(`服务已启动: http://${HOST}:${PORT}`);
  console.log(`  env=${APP_ENV}  greeting=${GREETING}  hostname=${os.hostname()}  pid=${process.pid}`);
  console.log(`  探针地址: /healthz  /readyz`);
});

// ---------- 优雅停机（生产必做）----------
// K8s 删除 Pod 时会先发 SIGTERM，给你一段时间处理完手头的请求，超时才 SIGKILL。
// 时间长度由 Deployment 里的 terminationGracePeriodSeconds 控制（默认 30 秒）。
// 如果这里不处理，进程会被直接杀掉 —— 正在处理的请求就断了。
// → 这就是"滚动更新期间用户零感知"的一个必要环节。
['SIGTERM', 'SIGINT'].forEach((signal) => {
  process.on(signal, () => {
    console.log(`收到 ${signal}，开始优雅停机（不再接收新连接）...`);
    server.close(() => {
      console.log('所有在途请求已处理完，退出。');
      process.exit(0);
    });
    // 兜底：无论怎样，10 秒后强制退出，避免卡死
    setTimeout(() => {
      console.log('等待超时，强制退出。');
      process.exit(1);
    }, 10000).unref();
  });
});
