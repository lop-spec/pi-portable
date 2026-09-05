# pi bash 工具预加载(经 BASH_ENV 注入,每次工具调用的非交互 bash 都会先 source 本文件)。
# 目的:把模型每轮重复生成的 ssh 样板固化成零 token 的 helper。
# 约束:只定义函数/变量,不打印任何输出,不改 cwd,不 set -e(避免改变工具语义)。

# 已知受管主机(身份见 shared/rules-ondemand/ops-resources.md;禁 root,禁换账号)。
# 用法: yy 'cd /home/yy/x; docker ps'    ro109 'cat /etc/os-release'
yy()    { ssh.exe -o BatchMode=yes -o ConnectTimeout=10 yy@8.137.150.130 "$@"; }
ro109() { ssh.exe -o BatchMode=yes -o ConnectTimeout=10 ro-audit@47.109.94.69 "$@"; }
# 远端跑本地脚本文件,零转义: yyf ./x.sh [args]
yyf()   { local f="$1"; shift; ssh.exe -o BatchMode=yes -o ConnectTimeout=10 yy@8.137.150.130 bash -s -- "$@" < "$f"; }

# 2026-09-04:ev/evq 已删除,改用 pi bash 工具的原生输出处理。
# 原生行为(pi-coding-agent 内置,比 ev 宽得多):上下文里保留至多 102400 字节;
# 累计超过 51200 字节即把**完整输出**落到 %TEMP%\pi-bash-<hex>.log 并把该路径随
# 工具结果回传给模型;顺带 strip ANSI、清理二进制、归一 CR。
# ev 只回显末尾 40 行,中段输出模型永远看不到,是对模型所见的单方面裁剪,故退役。
# 需要任务级证据文件时直接用重定向:  <命令> >> acceptance-evidence.md 2>&1

# 2026-09-05:规则里的"备份→改→读回→同步对端"各固化成一条命令(单一真值在 tools/backup.mjs、tools/peer-sync.mjs):
#   bak <文件...> [--label x]         精确物理备份到就近 _历史版本/ 并读回哈希
#   peerpush <文件...>                整文件同步到另一台受管机(对端备份+传输+SHA256 读回+node --check)
#   peerpatch <文件> <<'JSON'         只同步改动行: {"old":"...","new":"..."},用于 AGENTS.md 这类含机器特有内容的文件
_pi_tools() { printf '%s' "${PI_PORTABLE_HOME:-C:/Users/lop/Documents/claude/pi-portable}/tools"; }
bak()       { node "$(_pi_tools)/backup.mjs" "$@"; }
peerpush()  { node "$(_pi_tools)/peer-sync.mjs" push "$@"; }
peerpatch() { node "$(_pi_tools)/peer-sync.mjs" patch "$@"; }
