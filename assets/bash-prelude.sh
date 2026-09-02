# pi bash 工具预加载(经 BASH_ENV 注入,每次工具调用的非交互 bash 都会先 source 本文件)。
# 目的:把模型每轮重复生成的样板(ssh 头、证据落盘)固化成零 token 的 helper。
# 约束:只定义函数/变量,不打印任何输出,不改 cwd,不 set -e(避免改变工具语义)。
# 2026-09-02 实录:单会话 15 条 ssh 各重复 ~60 字符头+多层转义;证据用 write 复述工具输出 5K 字符。

# 已知受管主机(身份见 shared/rules-ondemand/ops-resources.md;禁 root,禁换账号)。
# 用法: yy 'cd /home/yy/x; docker ps'    ro109 'cat /etc/os-release'
yy()    { ssh.exe -o BatchMode=yes -o ConnectTimeout=10 yy@8.137.150.130 "$@"; }
ro109() { ssh.exe -o BatchMode=yes -o ConnectTimeout=10 ro-audit@47.109.94.69 "$@"; }
# 远端跑本地脚本文件,零转义: yyf ./x.sh [args]
yyf()   { local f="$1"; shift; ssh.exe -o BatchMode=yes -o ConnectTimeout=10 yy@8.137.150.130 bash -s -- "$@" < "$f"; }

# 证据落盘 helper:执行命令,完整输出追加到证据文件(默认 ./acceptance-evidence.md,可用 EV_FILE 覆盖),
# 只把末尾 ${EV_TAIL:-40} 行回显给模型;退出码原样返回。模型只需在证据文件里手写结论行。
# 用法: ev docker ps      ev bash -c 'x | y'      EV_TAIL=5 ev ./verify.mjs
ev() {
  local f="${EV_FILE:-acceptance-evidence.md}" tail_n="${EV_TAIL:-40}" ts rc
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  printf '\n### [%s] $ %s\n```\n' "$ts" "$*" >> "$f"
  "$@" 2>&1 | tee -a "$f" | tail -n "$tail_n"
  rc="${PIPESTATUS[0]}"
  printf '```\nexit=%s\n' "$rc" >> "$f"
  return "$rc"
}
# 只记不回显(输出很大时): evq cmd...
evq() { EV_TAIL=0 ev "$@"; }
