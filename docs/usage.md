# mp_clangd 使用说明

本文说明 `mp_clangd.yaml` 的 schema、ProfileSet 契约、手工生成 ProfileSet 的方法，以及 Ascend preset 与示例 provider 的用法。零配置快速开始与 CLI 命令概览见 [README](../README.md)。

## 1. 快速参考

```bash
MP_CLANGD=/path/to/mp_clangd/packages/cli/dist/main.js
cd /path/to/project

node "$MP_CLANGD" init
node "$MP_CLANGD" refresh
node "$MP_CLANGD" profiles
node "$MP_CLANGD" profile build/debug
node "$MP_CLANGD" unit src/kernel.cpp
node "$MP_CLANGD" unit src/kernel.cpp b.o
node "$MP_CLANGD" headers include/kernel_operator.h
node "$MP_CLANGD" doctor
```

- `mp-clangd` 的所有命令都以当前工作目录作为 workspace。
- `.mpclangd/profiles.json`、`.mpclangd/compile_commands.json`、`.mpclangd/state.json` 都写入 workspace。
- CLI 的 `profile` 切换后立即重新物化 `.mpclangd/compile_commands.json`；CLI 的 `unit` 只保存选择，需再执行 `refresh` 后生效。VSCode 扩展的 profile/unit 切换会立即重新物化并重启 clangd。

## 2. `mp_clangd.yaml` schema

### 2.1 位置与默认值

- 文件位置：workspace 根目录的 `mp_clangd.yaml`。
- 文件不存在时，等价于：

  ```yaml
  providers:
    - use: builtin:cdb
  ```

- 文件存在时，`providers` 是唯一必需字段，且必须是数组。
- `providers` 是完整集合：不会自动追加 `builtin:cdb`。
- 解析失败、`providers` 不是数组、provider 字段类型错误时，CLI/扩展会返回可读错误。

### 2.2 顶层结构

```yaml
providers:
  - use: builtin:cdb
    include: ["compile_commands.json", "build*/**/compile_commands.json"]
    exclude: [".git", "node_modules", ".tmp"]
  - use: command
    command: ["node", "tools/my-provider.mjs", "--workspace", "{workspace}"]
    config: "tools/provider.yaml"
    output: ".mpclangd/profiles.json"
```

每个 provider 的 `use` 只能是：

- `builtin:cdb`：内置 CDB 发现 provider。
- `command`：执行外部命令并读取其输出的 provider。

### 2.3 `builtin:cdb`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `use` | `"builtin:cdb"` | 是 | 选择内置 provider。 |
| `include` | `string[]` | 否 | 相对 workspace 的 glob 模式，传给 `fast-glob`。默认值见下。 |
| `exclude` | `string[]` | 否 | 相对 workspace 的排除 glob。默认值见下。 |

默认 `include`：

```text
compile_commands.json
build*/**/compile_commands.json
out/**/compile_commands.json
cmake-build-*/**/compile_commands.json
```

默认 `exclude`：

```text
.git/**
node_modules/**
.tmp/**
.mpclangd/**
```

发现深度固定为 4（`maxDepth` 只作为库 API 参数暴露，不能通过 YAML 配置）。每个 CDB 生成一个 profile：

- profile id 取 CDB 所在目录相对 workspace 的 POSIX 路径。
- workspace 根目录的 CDB 对应 `default`。
- id 冲突时依次追加 `#2`、`#3`。
- CDB entry 的 `directory` 缺失时报错；相对 `directory` 按 CDB 文件所在目录解析；`file` 按最终 `directory` 解析。
- `arguments` 与 `command` 两种 CDB 形式都支持；`command` 使用 shell-quote 分词。

### 2.4 `command`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `use` | `"command"` | 是 | 选择外部命令 provider。 |
| `command` | `string[]` | 是 | 可执行文件与参数，必须非空。 |
| `config` | `string` | 否 | provider 配置文件路径；相对路径按 workspace 解析。 |
| `output` | `string` | 否 | provider 输出文件；设置后从文件读取 ProfileSet，而不是 stdout。 |

执行语义：

- 使用 `spawnSync(executable, args)` 直接执行，不经过 shell；因此管道、重定向和 shell 变量不会生效。
- 工作目录是 workspace。
- `command` 的每个 token 支持 `{workspace}` 替换为 workspace 绝对路径。
- 设置 `config` 后：
  - `config` 路径解析为绝对路径；
  - `command` token 中的 `{config}` 替换为该绝对路径；
  - 子进程环境变量增加 `MP_CLANGD_PROVIDER_CONFIG=<绝对路径>`。
- `output` 路径相对 workspace 解析，并支持 `{workspace}`；设置后不读取 stdout。
- 退出码非 0、输出为空、输出不是合法 JSON、或输出不符合 ProfileSet 契约时，命令会失败并在 stderr 中给出错误摘要。

注意：`config` 只是约定字段，核心不会解析它，也不会自动把它作为 `--preset` 传给 provider；Ascend 示例 provider 通过 `--preset` 参数接收 preset 路径。若需要 `{config}`，请显式写在 `command` 中。

### 2.5 多 provider 合并

- provider 按 `providers` 顺序执行。
- 每个 provider 的结果都会先经过 ProfileSet 校验，再按顺序合并。
- 任意两个 provider 输出相同的 `profile.id` 时直接报错，不覆盖、不重命名。
- CLI 的 `refresh` 与 VSCode 扩展会把合并结果写入 `.mpclangd/profiles.json`。

### 2.6 配置示例：内置 provider + Ascend 示例 provider

```yaml
providers:
  - use: builtin:cdb
    include: ["build*/**/compile_commands.json"]

  - use: command
    command:
      - node
      - /abs/path/to/mp_clangd/examples/ascend-provider/dist/main.js
      - --workspace
      - "{workspace}"
      - --preset
      - /abs/path/to/mp_clangd/examples/ascend-provider/preset.yaml
```

如果 provider 脚本或 preset 位于 workspace 之外，使用绝对路径；命令 provider 的工作目录是 workspace，相对路径会按 workspace 解析。若内置 provider 与 Ascend provider 都发现了同一个 CDB，可能产生相同的 base profile id（例如都叫 `build`），此时需要调整 `include`/`exclude` 或改用只启用 Ascend provider 的配置。

## 3. ProfileSet 契约

ProfileSet 是 provider 与核心之间的唯一契约。

```json
{
  "profiles": [
    {
      "id": "build/debug",
      "entries": [
        {
          "directory": "/abs/build/debug",
          "file": "/abs/src/kernel.cpp",
          "arguments": ["clang++", "-std=c++17", "-c", "/abs/src/kernel.cpp", "-o", "kernel.o"]
        }
      ]
    }
  ]
}
```

字段约束：

| 字段 | 约束 |
|---|---|
| 顶层 | 必须是对象，包含 `profiles` 数组。 |
| `profiles[].id` | 非空字符串；同一 ProfileSet 内唯一。 |
| `profiles[].entries` | 数组。 |
| `entries[].directory` | 必须是绝对路径。 |
| `entries[].file` | 非空字符串；相对路径按 `directory` 解析。 |
| `entries[].arguments` | 非空字符串数组；第一项是编译器/驱动。 |

补充语义：

- 同一 profile 内同一 `file` 的多条不同 entry 表示多个 unit。
- `entryKey` 由 `directory` 与 `arguments` 计算；完全相同的命令会去重。
- provider 负责把命令转换成 clangd 可用的 driver 风格：保留 include、宏和标准参数，移除目标编译器专有参数，补上关键字擦除宏。
- 核心不检查 `file` 是否存在，也不执行编译器。
- 核心不会自动补 `-x c++`、`-D` 宏或 include 路径；这些都属于 provider 的职责。

## 4. 手工生成 ProfileSet

### 4.1 直接提供文件

VSCode 扩展在激活时优先读取 `.mpclangd/profiles.json`；如果文件存在且合法，就直接使用。激活阶段不运行 provider；文件不存在时也不会在激活阶段运行 provider。`Refresh`、`Select Profile`、`Select Compile Unit` 会运行 provider。适合由外部构建系统生成 ProfileSet 的场景。

```text
<workspace>/.mpclangd/profiles.json
```

注意：

- CLI 的 `profiles`、带名字的 `profile`、`unit`、`headers` 与 `refresh` 始终运行 provider，不会读取这个文件；不带名字的 `profile` 只读取 `state.json`。
- 扩展的 `Refresh` 与 `Select Profile` 会重新运行 provider 并覆盖该文件。
- `.mpclangd/` 默认被 `mp-clangd init` 加入 `.gitignore`。

### 4.2 通过 command provider 提供

如果希望 CLI 和扩展都使用手工 ProfileSet，可以让 command provider 把文件内容输出到 stdout：

```yaml
providers:
  - use: command
    command:
      - node
      - -e
      - "process.stdout.write(require('fs').readFileSync('.mpclangd/profiles.json','utf8'))"
```

该命令的工作目录是 workspace，因此相对路径 `.mpclangd/profiles.json` 可用；`node -e` 默认按 CommonJS 执行，`require` 可用。也可以使用 `["cat", ".mpclangd/profiles.json"]`（POSIX 环境）。

### 4.3 手工 ProfileSet 示例

```json
{
  "profiles": [
    {
      "id": "manual/AIC",
      "entries": [
        {
          "directory": "/home/me/project/build",
          "file": "kernel.cpp",
          "arguments": [
            "bisheng",
            "-x", "c++",
            "-D__DAV_CUBE__=1",
            "-D__gm__=",
            "-c", "kernel.cpp",
            "-o", "kernel.o"
          ]
        }
      ]
    },
    {
      "id": "manual/AIV",
      "entries": [
        {
          "directory": "/home/me/project/build",
          "file": "kernel.cpp",
          "arguments": [
            "bisheng",
            "-x", "c++",
            "-D__DAV_VEC__=1",
            "-D__gm__=",
            "-c", "kernel.cpp",
            "-o", "kernel.o"
          ]
        }
      ]
    }
  ]
}
```

要点：

- `directory` 必须是绝对路径；`file` 用相对路径时按 `directory` 解析。
- 宏、include 路径与关键字擦除需要手工写好；核心不会补全。
- 两个 profile 使用不同宏时，切换 profile 会改变物化 CDB 中的 entry。
- 手工 entry 不会经过 probe；如果编译器专有参数会干扰 clangd，需要自行移除。

### 4.4 unit 与选择持久化

- 同一 profile 内同一 `file` 有多条 entry 时，CLI 的 `unit <file>` 会列出所有 unit。
- label 规则：差异 `-D` → `-o` basename → `unit <序号>`；冲突时追加 ` #2`、` #3`。
- 选择结果按 `(profileId, file)` 保存到 `.mpclangd/state.json`。
- 未选择时使用该文件排序后的第一条 unit。
- CLI 的 `unit` 命令只保存选择；执行 `mp-clangd refresh` 或再次选择 profile 后才会写入物化 CDB。VSCode 扩展会立即重新物化。

## 5. Ascend preset

Ascend 示例 provider 的 preset 是数据文件，默认位于 `examples/ascend-provider/preset.yaml`。核心不读取 preset；只有示例 provider 使用它。

```yaml
name: ascend
match:
  compilers: ["*bisheng*", "*ccec*"]
  args_any: ["-xasc", "-x asc", "-x cce"]
probe:
  parse: cc1
  passes:
    - name: AIC
      arch_suffix: "-cube"
      macros: [__NPU_DEVICE__, __DAV_CUBE__, __DAV_C220_CUBE__]
    - name: AIV
      arch_suffix: "-vec"
      macros: [__NPU_DEVICE__, __DAV_VEC__, __DAV_C220_VEC__]
sanitize:
  remove_args: ["-xasc", "-x asc", "-xcce", "-x cce", "--npu-arch=*", "--cce-*"]
  add_args: ["-x", "c++"]
  keyword_defines: [__gm__, __global__, __vector__, __cube__, __aicore__]
```

### 5.1 字段说明

| 字段 | 说明 |
|---|---|
| `name` | preset 名称，仅用于标识。 |
| `match.compilers` | 编译器 basename 的 glob 列表；`*bisheng*` 可匹配 `/opt/.../bisheng`。 |
| `match.args_any` | 命令参数匹配列表。每一项可以是单个 token（如 `-xasc`），也可以是相邻两个 token 用空格拼接（如 `-x cce`）。 |
| `probe.parse` | 固定为 `cc1`；当前实现只解析 cc1 行。 |
| `probe.passes[].name` | pass 名称；生成的 profile id 为 `<base>/<name>`。 |
| `probe.passes[].arch_suffix` | 用于识别 pass：cc1 命令的 `-o` 以 `<arch_suffix>.o` 结尾，或 `-fcce-aicore-arch` 以 `<arch_suffix>` 结尾。 |
| `probe.passes[].macros` | 该 pass 的宏；以 `-D<macro>=1` 追加到 clangd entry。 |
| `sanitize.remove_args` | 需要移除的参数。不含空格时按单个 token 匹配；以 `*` 结尾时按前缀匹配；含空格时按相邻 token 对匹配。 |
| `sanitize.add_args` | 需要追加的参数；已存在时不重复追加。 |
| `sanitize.keyword_defines` | Ascend 关键字擦除宏；以 `-D<keyword>=` 追加。 |

### 5.2 展开规则

对每个 base profile：

1. 用 preset 的 `match` 分流 entry。
2. 对每个匹配 entry 运行 compiler probe：
   - 复制原命令，移除已有 `-o` 及其值；
   - 追加 `-v -c -o <workspace>/.mpclangd/cache/probe/probe-<uuid>.o`；
   - 在 entry 的 `directory` 下执行编译器；
   - 从 stderr 解析包含 ` -cc1 ` 的行。
3. 按每个 pass 的 `arch_suffix` 找到对应 cc1 命令；找不到时报错。
4. 用原 driver 命令 + `sanitize` + 该 pass 的宏生成 clangd entry。
5. 为每个 pass 生成 `<base>/<pass.name>` profile；非匹配 entry 原样复制到每个派生 profile。
6. 没有任何匹配 entry 的 base profile 原样保留。

注意：

- probe 只要求 cc1 行中出现 preset 声明的 pass；编译器后续报错不会阻止 pass 解析。完整编译是否成功由构建系统决定。
- probe 产生的临时 `.o` 文件会留在 `.mpclangd/cache/probe/`，当前不会自动清理；编译器 stderr 只在内存中解析，不会写入日志文件。
- 如果 probe 找不到某个 pass，命令会失败并报告该 pass 与 `arch_suffix`。
- preset 宏只是按声明注入 `-D<macro>=1`；当前实现不会运行 `-dM` 逐项校验宏集合。

### 5.3 构建日志采集

示例 provider 支持 `--build-log <file>`。采集规则：

- 识别以 `bisheng` 或 `ccec` 开头的行，也识别 `cd <dir> && <compiler> ...`。
- `cd` 目录按 workspace 解析；没有 `cd` 时使用 workspace。
- 命令在第一个 shell 运算符（管道、重定向等）处截断，避免 `| tee`、`2>&1` 等进入参数。
- 单独的文件描述符序号（如 `2>&1` 中的 `2`）会被丢弃。
- glob token（如 `inc/*.h`）会被跳过，但其后的参数继续保留。
- 必须包含 `-c` 或 `-x`，否则跳过。
- 输出文件取 `-o` 的下一个 token。
- 源文件优先取 `-c` 之后的第一个非选项 token；否则取最后一个 `.c`/`.cc`/`.cpp`/`.cxx` token。
- 相同 entry 去重。
- 采集结果合并为 id 为 `harvested` 的 base profile，再按 preset 展开成 `harvested/AIC`、`harvested/AIV` 等。

限制：

- `cd` 目录名包含空格（带引号）时不支持。
- `-c -I /path file.cpp` 这类分离式选项可能把选项值误判为源文件；推荐使用 `-I/path` 或 `-c file.cpp` 形式。
- 日志中的路径必须能在当前环境访问；probe 会实际执行该命令。

## 6. 状态、物化与 clangd

### 6.1 状态文件

`.mpclangd/state.json` 保存：

- `activeProfile`：当前 profile id。
- `fileUnits`：`(profileId, file)` 到 unit key 的映射。
- `headerRoots`：`(profileId, header)` 到 `{rootFile, unitKey}` 的映射。
- `headerHistory`：每个头文件的根 TU 历史，最多 20 条，最近优先。

文件中的键是内部复合键；不要手工编辑。状态损坏时按空状态加载。

### 6.2 物化规则

- 每个文件只保留一条 entry：当前选中的 unit，否则按 label 排序后的第一条 unit。
- 结果为 `.mpclangd/compile_commands.json`，使用临时文件 + rename 原子写入。
- 切换 profile 时重建整份物化 CDB；切换 unit 时只改变受影响文件（实现上仍会重写整份文件，但其他文件的选择保持不变）。
- CLI 的 `unit` 命令不直接调用物化；执行 `mp-clangd refresh` 后会按保存的 unit 重新物化。VSCode 扩展的 unit 切换会立即物化。
- 头文件 entry 来自 `headerRoots`：复制根 TU 的命令，把 `arguments` 中的源文件 token 替换为头文件路径；找不到对应 unit 时跳过。
- 扩展在切换 profile/unit/头文件根后调用 `clangd.restart`；CLI 的 `profile`/`refresh` 只写文件，clangd 会按 CDB 变化热重载。

### 6.3 clangd 参数

官方 clangd 扩展需要：

```json
{
  "clangd.arguments": ["--compile-commands-dir=.mpclangd"]
}
```

扩展激活时会检查 `.vscode/settings.json`；缺少该参数时提示写入。CLI 的 `doctor` 也会检查该文件。

`mp-clangd doctor` 与 VSCode 的 `mp_clangd: Doctor` 还会逐个运行 `mp_clangd.yaml` 中配置的 provider，并输出：

```text
provider builtin:cdb: ok
provider command: failed - provider command "node" exited with code 3
```

单个 provider 失败不会中止后续 provider 或文件检查；`doctor` 始终返回 0，便于一次查看全部状态。

## 7. 常见问题

**`profiles` 输出 `no profiles`**

- 确认 workspace 内有 `compile_commands.json`，或位于默认发现目录中。
- 确认 `mp_clangd.yaml` 的 `include`/`exclude` 没有排除该文件。
- Ascend provider 可用 `--cdb` 显式指定 CDB。

**`profile "<id>" not found`**

- 先运行 `mp-clangd profiles`，使用输出的完整 profile id（区分大小写与 `/`）。
- 切换后 `.mpclangd/state.json` 中的 `activeProfile` 会保留；若 provider 输出变化导致该 id 消失，`refresh` 会报错，需要重新选择。

**command provider 报错**

- 检查 `command[0]` 是否可执行、参数是否需要 `{workspace}`/`{config}`、工作目录是否正确。
- 检查 provider 退出码、stderr 与输出是否为合法 JSON。
- 不同 provider 输出重复 profile id 时，合并会失败。

**`probe did not emit pass ...`**

- 确认 preset 的 `arch_suffix` 与编译器实际输出后缀一致。
- 确认在容器/环境中能直接运行该编译命令；probe 需要真实执行编译器。
- 确认 entry 的 `directory` 与 include 路径有效。

**头文件没有 include 链**

- 静态扫描只解析 `-I`、`-isystem`、`-iquote`、`-idirafter` 和源文件目录。
- 条件编译或生成文件缺失时可能漏掉 include。
- 确认头文件路径在 workspace 内；workspace 外的头文件不会进入图。

**clangd 没有重新加载**

- 在 VSCode 命令面板执行 `clangd.restart`。
- 确认 `clangd.arguments` 包含 `--compile-commands-dir=.mpclangd`。
- 确认 `.mpclangd/compile_commands.json` 的修改时间已更新。

## 8. 相关文档

- [README](../README.md)：项目定位、零配置用法、CLI 与扩展概览。
- [Ascend 示例 provider](../examples/ascend-provider/README.md)：运行方式、`cann_tmp` 验收与构建日志验收。
- [设计文档](superpowers/specs/2026-11-20-mp-clangd-multiconfig-design.md)：完整设计与 M1 范围。
