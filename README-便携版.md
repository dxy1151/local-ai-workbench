# 星野·本地版 — 当前部署（v1.7.2，机械盘）

**自启动服务跑的是机械盘上的部署副本**：
`/mnt/data500/xingye-chat-portable`（500G 机械盘，NTFS）

## 结构

- 代码维护目录（git 仓库，本地）：`/home/don0ox1/xingye-chat`
- 部署副本（systemd 自启动跑这个）：`/mnt/data500/xingye-chat-portable`
- 数据（角色 / 会话 / 资料，全部实时）：`/home/don0ox1/xingye-sync`
  - 两个目录都不存数据：各自的 `data-dir.txt` 都指向上面这个路径
- 备用副本：`/mnt/data4t/xingye-chat-portable`

## 维护流程

```bash
# 1. 在 ~/xingye-chat 改代码
# 2. 同步到机械盘并重启服务
bash ~/xingye-chat/tools/deploy-hdd.sh
```

## 运行

```bash
systemctl --user status xingye-chat     # 状态
systemctl --user restart xingye-chat    # 重启
curl -s http://127.0.0.1:5178/api/config   # 看版本/模型
```

浏览器打开 http://127.0.0.1:5178

## 注意

- `/mnt/data500` 是 fstab 里的 ntfs3（nofail）；服务启动前会等最多 30 秒确认盘已挂上。
- **API Key 已清空**（原来的 Key 已失效删除）。要恢复云端聊天，去 设置 → API Key 重新填。
- 数据目录和部署目录不要同时开两个服务实例（同一份会话文件会互相覆盖）。
