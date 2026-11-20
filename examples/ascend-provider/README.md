# Ascend 示例 provider

本目录是 mp_clangd 的 Ascend C 示例 provider。它不属于核心，只演示插件层如何把 `bisheng`/`ccec` 的多 pass 编译展开成 mp_clangd 可直接消费的 ProfileSet：

- 从 `compile_commands.json` 或构建日志中取得 kernel entry；
- 对匹配 preset 的 entry 执行 compiler probe（`-v -c`），解析 cc1 命令行；
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

不传 `--preset` 时，默认使用 `dist/main.js` 上一级目录中的 `preset.yaml`（仓库内即 `examples/ascend-provider/preset.yaml`）。如果把 `dist/` 的内容平铺到其他目录，请显式传 `--preset`。

### 2.1 选项

| 选项 | 说明 |
|---|---|
| `--workspace <dir>` | workspace 根目录；默认是当前目录。相对路径按当前目录解析。 |
| `--preset <file>` | preset 文件；默认是 `dist/main.js` 上一级目录中的 `preset.yaml`。 |
| `--cdb <file>` | 指定 `compile_commands.json`，可重复；指定后不再自动发现 CDB。 |
| `--build-log <file>` | 从构建日志采集 `bisheng`/`ccec` entry。 |
| `--help`, `-h` | 显示帮助。 |

不传 `--cdb` 时，使用与内置 `builtin:cdb` 相同的发现规则：workspace 根目录、`build*/**`、`out/**`、`cmake-build-*/**`，最大深度 4，忽略 `.git`、`node_modules`、`.tmp`、`.mpclangd`。

### 2.2 输入与输出

- 输入：一个或多个 CDB，和/或一份构建日志。
- 输出：stdout 上的 ProfileSet JSON；错误写 stderr，退出码非 0。
- 不写文件；需要保存时由调用方重定向或用 `command` provider 的 `output` 选项。
- probe 临时文件写入 `<workspace>/.mpclangd/cache/probe/`；workspace 必须可写。
- 运行前请确认 `bisheng` 或 `ccec` 在 `PATH` 中，或 CDB/日志里是绝对路径。

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

probe 会在 fixture 目录下生成 `.mpclangd/cache/probe/`，该目录被仓库 `.gitignore` 忽略。

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

结论：`default/AIC` 与 `default/AIV` 两个 profile 均生成；AIC 含 `-D__DAV_CUBE__=1`，AIV 含 `-D__DAV_VEC__=1`；`-xasc` 与 `--npu-arch=dav-2201` 已移除并替换为 `-x c++`。

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
podman exec -w /tmp/ws cann_tmp /tmp/node /tmp/ascend-provider/main.js \
  --workspace /tmp/ws \
  --preset /tmp/ascend-provider/preset.yaml
```

实际结果：

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

## 7. 已知限制

- probe 依赖真实编译器；首次运行每个匹配 entry 都会执行一次 `-v -c`。
- probe 缓存目录当前不会自动清理。
- preset 宏按声明注入，不做 `-dM` 校验。
- 构建日志的 `cd` 目录不支持空格；分离式选项可能误判源文件。
- `dist/main.js` 不是完全自包含：运行时需要 `yaml` 与 `shell-quote`。
- 示例 provider 只处理 `bisheng`/`ccec` 的多 pass 展开；核心与 provider 的通用契约见 [docs/usage.md](../../docs/usage.md)。
