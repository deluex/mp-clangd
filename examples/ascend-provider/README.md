# Ascend 示例 provider

本目录是 mp_clangd 的 Ascend C 示例 provider。它不属于核心，只演示插件层如何把 `bisheng`/`ccec` 的多 pass 编译展开成 mp_clangd 可直接消费的 ProfileSet：

- 从 `compile_commands.json` 或构建日志中取得 kernel entry；
- 对匹配 preset 的 entry 执行 compiler probe（`-v -c`），解析 cc1 命令行，并用 `-dM -E` 校验 preset 宏；
- probe 结果按编译器/参数/源文件 mtime 缓存在 `.mpclangd/cache/probe/<hash>.json`，命中时不再启动编译器；
- probe 或宏校验失败时按 entry 回退为 `unverified: true`，继续处理其他 entry；
- 为每个 pass 生成一个 profile：`<base>/AIC`、`<base>/AIV`；
- 移除目标编译器专有参数，补上 pass 宏与 Ascend 关键字擦除宏。

preset 的字段语义见 [docs/usage.md](../../docs/usage.md) 的“Ascend preset”一节。

## 1. 构建

在 mp_clangd 仓库根目录：

```bash
npm install
npm run build --workspace @mp-clangd/ascend-provider
```

产物是 `examples/ascend-provider/dist/main.js`。

注意：`dist/main.js` 把 `@mp-clangd/core` 与 `@mp-clangd/provider-cdb` 打进 bundle，但 `yaml` 和 `shell-quote` 仍是运行时外部依赖。在仓库内运行时 Node 会从根 `node_modules` 解析；如果把 `dist/` 单独复制到其他目录，需要同时提供 `node_modules/yaml` 与 `node_modules/shell-quote`（见第 5 节的容器验收）。

## 2. 运行

```bash
node examples/ascend-provider/dist/main.js \
  --workspace /path/to/workspace \
  --preset examples/ascend-provider/preset.yaml
```

不传 `--preset` 时，默认使用与 `dist/` 同级的 `preset.yaml`（仓库内即 `examples/ascend-provider/preset.yaml`）。如果把 `dist/` 的内容平铺到其他目录，请显式传 `--preset`。

### 2.1 选项

| 选项 | 说明 |
|---|---|
| `--workspace <dir>` | workspace 根目录；默认是当前目录。相对路径按当前目录解析。 |
| `--preset <file>` | preset 文件；默认是与 `dist/` 同级的 `preset.yaml`。 |
| `--cdb <file>` | 指定 `compile_commands.json`，可重复；指定后不再自动发现 CDB。 |
| `--build-log <file>` | 从构建日志采集 `bisheng`/`ccec` entry。 |
| `--help`, `-h` | 显示帮助。 |

不传 `--cdb` 时，使用与内置 `builtin:cdb` 相同的发现规则：workspace 根目录、`build*/**`、`out/**`、`cmake-build-*/**`，最大深度 4，忽略 `.git`、`node_modules`、`.tmp`、`.mpclangd`。

### 2.2 输入与输出

- 输入：一个或多个 CDB，和/或一份构建日志。
- 输出：stdout 上的 ProfileSet JSON；错误写 stderr，退出码非 0。
- 不写 ProfileSet 文件；需要保存时由调用方重定向或用 `command` provider 的 `output` 选项。
- probe 依赖 `<workspace>/.mpclangd/cache/probe/`；workspace 必须可写。
- 运行前请确认 `bisheng` 或 `ccec` 在 `PATH` 中，或 CDB/日志里是绝对路径。

### 2.3 probe 缓存、宏校验与回退

- **缓存**：每个匹配 entry 的 probe 结果写入 `<workspace>/.mpclangd/cache/probe/<hash>.json`。缓存键是 sha1(编译器路径 + 编译器 mtime + `entry.directory` + `entry.arguments` + 源文件 mtime)；命中时跳过编译器调用。
- **临时目录**：未命中时在 `.mpclangd/cache/probe/run-<uuid>/` 下生成 probe 输出；运行结束（成功或失败）后递归删除该目录及其中所有 cube/vec `.o`，不会累积对象文件。
- **宏校验**：对每个 pass 的 cc1 命令追加 `-dM -E`，检查 preset 为该 pass 声明的每个宏是否已定义；校验结果随 pass 一起缓存。
- **回退**：probe 抛错或宏校验失败时，该 entry 用原 driver 命令 + preset 的 pass 名称生成回退 entry，并置 `unverified: true`；stderr 输出一行警告，其他 entry 与 profile 继续生成。
- **资源上限**：probe 与宏校验的 `spawnSync` 使用 64 MiB `maxBuffer` 和 120 秒超时，避免大输出或卡死。

## 3. 最小 fixture

`fixtures/minimal/` 提供一个最小验收工程：

```text
fixtures/minimal/
├── compile_commands.json
└── kernel.cpp
```

`compile_commands.json` 的 `directory` 是 `"."`，由 cdb-provider 按 CDB 文件所在目录解析；`file` 为 `kernel.cpp`。`kernel.cpp` 使用 `__global__`、`__aicore__`、`__vector__`、`__gm__` 等 Ascend 关键字。

在装有 `bisheng` 的环境中：

```bash
node examples/ascend-provider/dist/main.js \
  --workspace examples/ascend-provider/fixtures/minimal \
  --preset examples/ascend-provider/preset.yaml
```

期望输出两个 profile：

- `default/AIC`：entry 包含 `-D__DAV_CUBE__=1`；
- `default/AIV`：entry 包含 `-D__DAV_VEC__=1`。

probe 会在 fixture 目录下生成 `.mpclangd/cache/probe/`，其中只有 `<hash>.json` 缓存；临时 `run-<uuid>/` 目录在每次 probe 后删除。`.mpclangd/` 被仓库 `.gitignore` 忽略。

## 4. 使用 `--build-log`

当 kernel 由 opc/TBE 等不产出 CDB 的流程编译时，把构建日志中真实的 `bisheng`/`ccec` 命令行交给 provider：

```bash
node examples/ascend-provider/dist/main.js \
  --workspace /path/to/workspace \
  --preset examples/ascend-provider/preset.yaml \
  --build-log /path/to/build.log
```

被识别的日志行示例：

```text
cd /path/to/build && bisheng -x cce --npu-arch=dav-2201 -I/path/to/include -c /path/to/add_example.cpp -o /path/to/add_example.o
```

采集结果会合并为 id 为 `harvested` 的 base profile；展开后得到 `harvested/AIC`、`harvested/AIV`。要求：

- 日志中的编译器路径与 include 路径在运行 provider 的环境中可访问；
- 命令能被重新执行（probe 会加 `-v -c` 再跑一次）；
- 管道、重定向会在第一个 shell 运算符处截断，不会进入参数；
- `cd <dir> && ...` 中的目录名不能包含空格；
- 同一命令重复出现时去重。

## 5. `cann_tmp` 容器验收

环境基线：容器 `cann_tmp` 内有 CANN 9.2.0、`bisheng` 在 `PATH` 中，但没有 Node。以下命令在 mp_clangd 仓库根目录执行，使用宿主机 Node 24。

### 5.1 准备

```bash
npm run build
podman cp /root/.nvm/versions/node/v24.18.0/bin/node cann_tmp:/tmp/node
podman exec cann_tmp chmod +x /tmp/node
podman cp examples/ascend-provider/dist cann_tmp:/tmp/ascend-provider
podman cp examples/ascend-provider/preset.yaml cann_tmp:/tmp/ascend-provider/preset.yaml
podman exec cann_tmp mkdir -p /tmp/ascend-provider/node_modules
podman cp node_modules/yaml cann_tmp:/tmp/ascend-provider/node_modules/yaml
podman cp node_modules/shell-quote cann_tmp:/tmp/ascend-provider/node_modules/shell-quote
podman cp examples/ascend-provider/fixtures/minimal cann_tmp:/tmp/minimal
```

`node_modules/yaml` 与 `node_modules/shell-quote` 是 `dist/main.js` 的运行时外部依赖；不复制会在容器内报 `ERR_MODULE_NOT_FOUND`。

### 5.2 运行

```bash
podman exec cann_tmp /tmp/node /tmp/ascend-provider/main.js \
  --workspace /tmp/minimal \
  --preset /tmp/ascend-provider/preset.yaml
```

实际输出：

```json
{
  "profiles": [
    {
      "id": "default/AIC",
      "entries": [
        {
          "directory": "/tmp/minimal",
          "file": "/tmp/minimal/kernel.cpp",
          "arguments": [
            "bisheng",
            "-c",
            "kernel.cpp",
            "-o",
            "kernel.o",
            "-x",
            "c++",
            "-D__NPU_DEVICE__=1",
            "-D__DAV_CUBE__=1",
            "-D__DAV_C220_CUBE__=1",
            "-D__gm__=",
            "-D__global__=",
            "-D__vector__=",
            "-D__cube__=",
            "-D__aicore__="
          ]
        }
      ]
    },
    {
      "id": "default/AIV",
      "entries": [
        {
          "directory": "/tmp/minimal",
          "file": "/tmp/minimal/kernel.cpp",
          "arguments": [
            "bisheng",
            "-c",
            "kernel.cpp",
            "-o",
            "kernel.o",
            "-x",
            "c++",
            "-D__NPU_DEVICE__=1",
            "-D__DAV_VEC__=1",
            "-D__DAV_C220_VEC__=1",
            "-D__gm__=",
            "-D__global__=",
            "-D__vector__=",
            "-D__cube__=",
            "-D__aicore__="
          ]
        }
      ]
    }
  ]
}
```

probe 缓存与临时文件核验（同一次运行后）：

```bash
podman exec cann_tmp find /tmp/minimal/.mpclangd -printf '%y %p %s\n'
podman exec cann_tmp cat /tmp/minimal/.mpclangd/cache/probe/*.json
```

实际结果只有一份缓存文件；内容为 pass 名称与 `-dM` 校验结果，不含对象文件：

```text
d /tmp/minimal/.mpclangd/cache/probe
f /tmp/minimal/.mpclangd/cache/probe/<sha1>.json

{
  "passes": [
    { "name": "AIC", "verified": true },
    { "name": "AIV", "verified": true }
  ]
}
```

再运行一次 provider，输出不变，缓存文件 mtime 不变（命中缓存，不再启动编译器）；`find /tmp/minimal -name '*.o'` 与 `run-*` 目录均为空。

结论：`default/AIC` 与 `default/AIV` 两个 profile 均生成；AIC 含 `-D__DAV_CUBE__=1`，AIV 含 `-D__DAV_VEC__=1`；`-xasc` 与 `--npu-arch=dav-2201` 已移除并替换为 `-x c++`；缓存命中时不重复 probe，临时对象不残留。

### 5.3 清理

```bash
podman exec cann_tmp rm -rf /tmp/minimal
podman exec cann_tmp rm -rf /tmp/ascend-provider
podman exec cann_tmp rm -rf /tmp/node
```

## 6. `fast_kernel_launch_example` 与 `add_example` 验收记录

验收对象位于 `/root/repo/cann/ops-transformer`（宿主机）。容器内没有该仓库，本次把所需目录复制到 `/tmp` 后验收，遵守“不修改容器 `/tmp` 之外内容”的约束。

### 6.1 `fast_kernel_launch_example`：CMake configure 生成 CDB

本次未能完成完整 wheel 构建：容器内缺少 Python `build` 模块，且 CMake 配置阶段需要从 gitcode 拉取 `opbase`，容器网络不可用（代理 `127.0.0.1:20808` 拒绝连接）。实际错误：

```text
ModuleNotFoundError: No module named 'build'
fatal: unable to access 'https://gitcode.com/cann/opbase.git/': Failed to connect to 127.0.0.1 port 20808 after 0 ms: Connection refused
CMake Error at /tmp/ops-transformer/build/_deps/opbase-subbuild/...:
  Failed to clone repository: 'https://gitcode.com/cann/opbase.git'
```

先把示例、仓库 `cmake/` 与 `common/` 复制到 `/tmp/ops-transformer/`（保持相对布局），并放置占位 `ops-base/include/op_common`、`ops-base/pkg_inc/op_common`（仅用于跳过网络拉取，不参与完整编译）：

```bash
podman exec cann_tmp mkdir -p /tmp/ops-transformer/examples /tmp/ops-transformer/cmake /tmp/ops-transformer/common
podman cp /root/repo/cann/ops-transformer/examples/fast_kernel_launch_example \
  cann_tmp:/tmp/ops-transformer/examples/fast_kernel_launch_example
podman cp /root/repo/cann/ops-transformer/cmake/. cann_tmp:/tmp/ops-transformer/cmake/
podman cp /root/repo/cann/ops-transformer/common/. cann_tmp:/tmp/ops-transformer/common/
podman exec cann_tmp mkdir -p /tmp/ops-transformer/ops-base/include/op_common \
  /tmp/ops-transformer/ops-base/pkg_inc/op_common
```

然后在容器内执行：

```bash
cmake -S /tmp/ops-transformer/examples/fast_kernel_launch_example \
      -B /tmp/ops-transformer/build \
      -DCMAKE_BUILD_TYPE=Release \
      -DTorch_DIR=/usr/local/python3.12.15/lib/python3.12/site-packages/torch/share/cmake/Torch \
      -DTORCH_NPU_PATH=/usr/local/python3.12.15/lib/python3.12/site-packages/torch_npu \
      -DNPU_SOC_VERSION=ascend910b \
      -DCANN_3RD_LIB_PATH=/tmp/ops-transformer/third_party
```

配置成功并生成 `/tmp/ops-transformer/build/compile_commands.json`（3 条 entry）。把该 CDB 复制到验收 workspace：

```bash
podman exec cann_tmp mkdir -p /tmp/ws/build
podman exec cann_tmp cp /tmp/ops-transformer/build/compile_commands.json \
  /tmp/ws/build/compile_commands.json
podman exec -w /tmp/ws cann_tmp bash -lc \
  '/tmp/node /tmp/ascend-provider/main.js --workspace /tmp/ws --preset /tmp/ascend-provider/preset.yaml > /tmp/ws/profiles.json'
```

原始 stdout 已保存到 `/tmp/ws/profiles.json`。按 profile 汇总（以下是对该文件的摘要，不是原始 JSON）：

```bash
podman exec cann_tmp python3 - <<'PY'
import json
d = json.load(open('/tmp/ws/profiles.json'))
print('profiles:', [p['id'] for p in d['profiles']])
for p in d['profiles']:
    print(p['id'], 'entries:', len(p['entries']))
    for e in p['entries']:
        args = e['arguments']
        print('  ', e['file'].split('/')[-1],
              'cube=', '-D__DAV_CUBE__=1' in args,
              'vec=', '-D__DAV_VEC__=1' in args)
PY
```

摘要输出：

```text
profiles: ['build/AIC', 'build/AIV']
build/AIC entries: 3
   extension.cpp      cube=False vec=False
   add.cpp            cube=True  vec=False
   grouped_matmul.cpp cube=True  vec=False
build/AIV entries: 3
   extension.cpp      cube=False vec=False
   add.cpp            cube=False vec=True
   grouped_matmul.cpp cube=False vec=True
```

`add.cpp` 的 AIC entry 末尾包含：

```text
-x c++ -D__NPU_DEVICE__=1 -D__DAV_CUBE__=1 -D__DAV_C220_CUBE__=1
-D__gm__= -D__global__= -D__vector__= -D__cube__= -D__aicore__=
```

AIV entry 对应包含 `-D__DAV_VEC__=1`、`-D__DAV_C220_VEC__=1`。非 `-xasc` 的 `extension.cpp` 原样保留在两个 profile 中。结论：provider 能把 `fast_kernel_launch_example` 的 CDB entry 派生为 AIC/AIV 两个 profile。本次验收只完成 CMake configure 与 CDB 生成，没有完成完整 wheel/链接构建。

### 6.2 `add_example`：`--build-log` 采集

`add_example` 的 kernel 由 opc/TBE 流程编译，CDB 中没有 entry；完整构建需要 CANN opbuild 生成的 tiling 头文件与整套算子构建环境，本次未在容器内完成。先复制 kernel 源码，并直接用 `bisheng` 编译一次，作为日志录制依据：

```bash
podman exec cann_tmp mkdir -p /tmp/add_example
podman cp /root/repo/cann/ops-transformer/examples/add_example/op_kernel/. \
  cann_tmp:/tmp/add_example/
podman exec -w /tmp/add_example cann_tmp bash -lc \
  'bisheng -x cce --npu-arch=dav-2201 -std=c++17 -w \
    -I/usr/local/Ascend/cann-9.2.0/x86_64-linux/tikcpp/tikcfw \
    -I/usr/local/Ascend/cann-9.2.0/x86_64-linux/tikcpp/tikcfw/interface \
    -I/usr/local/Ascend/cann-9.2.0/x86_64-linux/include \
    -c add_example.cpp -o add_example.o'
```

编译报错：

```text
error: use of undeclared identifier 'tilingData'
error: 'AddExampleTilingData' does not refer to a value
```

这些错误来自缺失的生成 tiling 头文件，不代表 probe 无法解析 pass。把下面这一行保存为 `/tmp/add_example/build.log`（真实 `bisheng` driver 命令行）：

```text
cd /tmp/add_example && bisheng -x cce --npu-arch=dav-2201 -std=c++17 -w -I/usr/local/Ascend/cann-9.2.0/x86_64-linux/tikcpp/tikcfw -I/usr/local/Ascend/cann-9.2.0/x86_64-linux/tikcpp/tikcfw/interface -I/usr/local/Ascend/cann-9.2.0/x86_64-linux/include -c add_example.cpp -o add_example.o
```

运行：

```bash
podman exec -w /tmp/add_example cann_tmp /tmp/node /tmp/ascend-provider/main.js \
  --workspace /tmp/add_example \
  --preset /tmp/ascend-provider/preset.yaml \
  --build-log /tmp/add_example/build.log
```

实际输出（节选）：

```json
{
  "profiles": [
    {
      "id": "harvested/AIC",
      "entries": [
        {
          "directory": "/tmp/add_example",
          "file": "/tmp/add_example/add_example.cpp",
          "arguments": [
            "bisheng",
            "-std=c++17",
            "-w",
            "-I/usr/local/Ascend/cann-9.2.0/x86_64-linux/tikcpp/tikcfw",
            "-I/usr/local/Ascend/cann-9.2.0/x86_64-linux/tikcpp/tikcfw/interface",
            "-I/usr/local/Ascend/cann-9.2.0/x86_64-linux/include",
            "-c",
            "add_example.cpp",
            "-o",
            "add_example.o",
            "-x",
            "c++",
            "-D__NPU_DEVICE__=1",
            "-D__DAV_CUBE__=1",
            "-D__DAV_C220_CUBE__=1",
            "-D__gm__=",
            "-D__global__=",
            "-D__vector__=",
            "-D__cube__=",
            "-D__aicore__="
          ]
        }
      ]
    },
    {
      "id": "harvested/AIV",
      "entries": [
        {
          "directory": "/tmp/add_example",
          "file": "/tmp/add_example/add_example.cpp",
          "arguments": [
            "bisheng",
            "-std=c++17",
            "-w",
            "-I/usr/local/Ascend/cann-9.2.0/x86_64-linux/tikcpp/tikcfw",
            "-I/usr/local/Ascend/cann-9.2.0/x86_64-linux/tikcpp/tikcfw/interface",
            "-I/usr/local/Ascend/cann-9.2.0/x86_64-linux/include",
            "-c",
            "add_example.cpp",
            "-o",
            "add_example.o",
            "-x",
            "c++",
            "-D__NPU_DEVICE__=1",
            "-D__DAV_VEC__=1",
            "-D__DAV_C220_VEC__=1",
            "-D__gm__=",
            "-D__global__=",
            "-D__vector__=",
            "-D__cube__=",
            "-D__aicore__="
          ]
        }
      ]
    }
  ]
}
```

结论：`--build-log` 成功采集 `add_example.cpp` 的 kernel entry，并展开为 `harvested/AIC` 与 `harvested/AIV` 两个 profile。probe 只解析编译器输出的 cc1 pass 行；尽管完整对象编译仍因缺少生成 tiling 头文件而失败，pass 解析与 ProfileSet 展开均成功。

### 6.3 清理

```bash
podman exec cann_tmp rm -rf /tmp/ws
podman exec cann_tmp rm -rf /tmp/add_example
podman exec cann_tmp rm -rf /tmp/ops-transformer
```

## 7. 未验证项（UNVERIFIED）

以下三项在本次环境中无法执行，状态为 **UNVERIFIED**。不要把它们当作已通过的验收项。

### 7.1 UNVERIFIED：stock clangd 解析物化 CDB

- **已尝试**：验证了 `.mpclangd/compile_commands.json` 的生成与内容（每个文件一条 entry，AIC/AIV 宏正确），但没有启动 clangd。
- **无法执行的原因**：宿主机与 `cann_tmp` 容器均没有 clangd 二进制；按约束不安装 OS 包。
- **操作员手工步骤**：
  1. 在安装 clangd（建议 ≥18）与官方 VSCode clangd 扩展的环境打开 workspace。
  2. 确保 `.vscode/settings.json` 含 `"clangd.arguments": ["--compile-commands-dir=.mpclangd"]`。
  3. 在 workspace 运行 `mp-clangd refresh`（或已存在合法的 `.mpclangd/compile_commands.json`）。
  4. 执行 `clangd --compile-commands-dir=.mpclangd --check=<workspace>/kernel.cpp`，确认输出了编译命令且没有 “Failed to find compilation database” 类错误。
  5. 在 VSCode 中打开 `kernel.cpp`，确认 include 与符号跳转可用、诊断中没有配置加载错误。

### 7.2 UNVERIFIED：状态栏 profile/unit 切换

- **已尝试**：扩展 bundle 构建成功；未启动 VSCode 扩展宿主或 UI。
- **无法执行的原因**：当前环境没有 VSCode UI/扩展宿主，无法点击状态栏或观察 clangd 重载。
- **操作员手工步骤**：
  1. 构建扩展：`npm run build --workspace mp-clangd-vscode`。
  2. 启动扩展宿主：`code --extensionDevelopmentPath=<repo>/packages/vscode-extension <workspace>`，并安装官方 clangd 扩展。
  3. 点击左侧状态栏 profile，选择 `default/AIV` 或 `build/AIV`，确认 `.mpclangd/compile_commands.json` 中对应 entry 含 `-D__DAV_VEC__=1`。
  4. 打开有多个 unit 的文件，点击右侧状态栏 unit，选择另一项，确认物化 CDB 与 clangd 诊断随之更新。
  5. 确认 clangd 被重启或重新加载（扩展调用 `clangd.restart`）。

### 7.3 UNVERIFIED：头文件树默认选择与记忆

- **已尝试**：验证了 include 图与 header model 的单元测试；未在 VSCode 树视图中操作。
- **无法执行的原因**：当前环境没有 VSCode UI/扩展宿主，无法打开头文件、查看 Include Paths 视图或跨会话验证记忆。
- **操作员手工步骤**：
  1. 在扩展宿主中打开包含多个根 TU 的头文件，确认 `mp_clangd Include Paths` 视图列出所有根 TU 与 include 链。
  2. 确认默认根符合优先级：导航来源文件 → 历史选择 → 路径字母序第一条。
  3. 通过 `mp_clangd: Select Header Root` 或点击树节点切换根，确认 `.mpclangd/compile_commands.json` 中该头文件的 entry 变为新根 TU 的命令。
  4. 重新打开 workspace 或重新激活扩展，确认该头文件仍选择上次根（`.mpclangd/state.json` 中的 `headerRoots`/`headerHistory`）。

## 8. 已知限制

- probe 依赖真实编译器；每个匹配 entry 首次运行会执行一次 `-v -c` 与每个 pass 一次 `-dM -E`，之后命中缓存。
- 缓存键包含编译器 mtime、参数与源文件 mtime，但不包含 preset 内容；修改 preset 后如需强制重新 probe，请删除 `.mpclangd/cache/probe/`。
- `-dM` 校验只覆盖 preset 声明的宏，不比较完整宏集合；校验失败时该 entry 标记 `unverified: true`。
- 构建日志的 `cd` 目录不支持空格；分离式选项可能误判源文件。
- `dist/main.js` 不是完全自包含：运行时需要 `yaml` 与 `shell-quote`。
- 示例 provider 只处理 `bisheng`/`ccec` 的多 pass 展开；核心与 provider 的通用契约见 [docs/usage.md](../../docs/usage.md)。
