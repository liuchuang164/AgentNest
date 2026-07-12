# AgentNest 远端只读 Preflight 报告

- 时间：`2026-07-12T07:38:49.297Z`
- 目标：`redacted`
- SSH：PASS（password，host key `SHA256:a2fMlWbZ8lsNYVHw875nlbD0FRvsMPV98ZqzZz59Awc`）
- OS：`ubuntu 22.04`
- 架构/内核：`x86_64 / 5.15.0-119-generic`
- CPU：`4`
- Memory：`15221 MiB`
- Free disk：`78955 MiB`
- REMOTE_WORKDIR：exists=`yes`，writable=`yes`
- OpenClaw official stable：`2026.6.11`（npm latest）

## 工具

| Tool | 只读探测结果 |
|---|---|
| Node | `v24.18.0` |
| npm | `11.16.0` |
| pnpm | `11.11.0` |
| Docker | `Docker version 29.6.1, build 8900f1d` |
| Docker Compose | `Docker Compose version v5.3.1` |
| Git | `git version 2.34.1` |
| curl | `curl 7.81.0 (x86_64-pc-linux-gnu) libcurl/7.81.0 OpenSSL/3.0.2 zlib/1.2.11 brotli/1.0.9 zstd/1.4.8 libidn2/2.3.2 libpsl/0.21.0 (+libidn2/2.3.2) libssh/0.9.6/openssl/zlib nghttp2/1.43.0 librtmp/2.3 OpenLDAP/2.5.16` |
| OpenClaw | `OpenClaw 2026.6.11 (e085fa1)` |

## 端口

- `18789`: `owned`
- `18080`: `owned`
- `18081`: `owned`
- `18082`: `owned`
- `15432`: `owned`

## 部署阻塞项

- 无。

## 部署准备项

- 无。

> 本次只执行远端读取命令；未安装、删除或修改服务器服务和项目目录。
