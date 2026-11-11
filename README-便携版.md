# 星野·本地版 — 本机部署备忘

> v2.4.1 重写：原文件写的是 **v1.7.2 + `/mnt/data500` 机械盘**，6 处事实全错
> （`/home/don0ox1/xingye-chat` 根本不存在；data500 上那份是 v1.9.1 的旧快照）。
> 下面按**当前实际部署**重写，以 `systemctl --user cat xingye-chat` 为准。

## 结构

| 角色 | 路径 | 说明 |
| --- | --- | --- |
| 部署目录（systemd 跑这个） | `/mnt/data4t/xingye-chat-portable` | 4TB 机械盘，v1.9.2 起从 data500 迁来（data500 偶尔脏盘挂不上，工作台就起不来） |
| 数据目录 | `/mnt/data4t/xingye-sync` | 角色卡 / 会话 / 资料，`data-dir.txt` 指定；单独同步 |
| 旧快照（只读参考） | `/mnt/data500/xingye-chat-portable` | **停在 v1.9.1**，不要再拿来跑 |

## 维护流程

```bash
# 在本机部署目录里改代码（它就是 git 仓库，分支见 git branch）
cd /mnt/data4t/xingye-chat-portable
git status                       # 确认改动范围
node smoke.js                    # 自检：必须"全部通过 ✅"且退出码 0
systemctl --user restart xingye-chat
systemctl --user status xingye-chat --no-pager
```

> 以前这里写的是 `bash ~/xingye-chat/tools/deploy-hdd.sh`，而 `~/xingye-chat` 不存在。

## 运行

```bash
systemctl --user status xingye-chat       # 状态
systemctl --user restart xingye-chat      # 重启
curl -s http://127.0.0.1:5178/api/version # 看版本（和 package.json 必须一致）
curl -s http://127.0.0.1:5178/api/config  # 看模型/后端
```

浏览器打开 http://127.0.0.1:5178

## 注意

- 服务启动前最多等 **60 秒**确认 `/mnt/data4t` 挂上（`ExecStartPre` + `RequiresMountsFor=/mnt/data4t`）。
- 口令 / 2FA 走 `EnvironmentFile=~/.config/xingye-tunnel/env`，也可以直接在网页设置里改
  （存 `~/.config/xingye-tunnel/auth.json`，优先级高于环境变量）。
- **同一份数据目录只能开一个实例**：两个进程同时写同一批会话文件会互相覆盖。
