#!/data/data/com.termux/files/usr/bin/bash
# 切换平板工作台用哪边跑模型
#   bash switch-tablet.sh local    # 平板自己跑（离线，2 tok/s）
#   bash switch-tablet.sh pc       # 连电脑跑（快 7 倍，需要电脑在线）
WB=http://127.0.0.1:5178

case "${1:-}" in
  local)
    curl -s -X PUT $WB/api/config -H 'Content-Type: application/json' \
      -d '{"baseUrl":"http://127.0.0.1:11434/v1","model":"qwen3-8b-v7k:latest","contextWindow":8192}' >/dev/null
    echo "✅ 已切到平板本地（约 2 tok/s，离线可用）"
    ;;
  pc)
    PC_IP="${2:-100.124.214.66}"
    curl -s -X PUT $WB/api/config -H 'Content-Type: application/json' \
      -d "{\"baseUrl\":\"http://$PC_IP:11434/v1\",\"model\":\"qwen3-8b-v7k:latest\",\"contextWindow\":16384}" >/dev/null
    echo "✅ 已切到电脑 $PC_IP（快约 7 倍）"
    ;;
  *)
    echo "用法: bash switch-tablet.sh local|pc [电脑IP]"
    echo "  当前配置:"
    curl -s $WB/api/config | tr ',' '\n' | grep -E '"baseUrl"|"model"|"contextWindow"' | head -3
    ;;
esac
