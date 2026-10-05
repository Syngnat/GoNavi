# shellcheck shell=bash
# 驱动代理构建 / 发布脚本共用：加载数据源描述表（internal/datasource/datasources.json）
# 里声明的驱动清单与查询函数。历史驱动仍由各脚本自己的清单维护，描述表驱动追加在其后。
#
# 用法：
#   source "$ROOT/tools/datasource-registry.sh"
#   load_datasource_registry "$ROOT"
#   DEFAULT_DRIVERS+=("${REGISTRY_DRIVERS[@]}")

resolve_datasource_registry_python() {
  local candidate
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 &&
      "$candidate" -c 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)' >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

load_datasource_registry() {
  local root="${1:?repository root required}"
  local python_bin definitions
  if ! python_bin="$(resolve_datasource_registry_python)"; then
    echo "未找到 Python 3，无法读取数据源描述表 internal/datasource/datasources.json" >&2
    return 1
  fi
  if ! definitions="$("$python_bin" "$root/tools/datasource-registry.py" shell)"; then
    echo "读取数据源描述表失败" >&2
    return 1
  fi
  eval "$definitions"
}
