#!/usr/bin/env python3
"""打包 EpicDeck 为 Decky Loader 可导入的 zip 插件包。

生成结构(Decky 标准格式):
    EpicDeck-v0.1.0.zip
    └── EpicDeck/
        ├── dist/index.js   (必填)
        ├── package.json    (必填)
        ├── plugin.json     (必填)
        ├── main.py         (必填,Python 后端)
        ├── py_modules/     (后端模块)
        ├── README.md       (推荐)
        └── LICENSE         (必填)

用法:
    python build_zip.py            # 打包当前版本
    python build_zip.py --skip-build   # 跳过 pnpm build(已构建过时)
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))


def read_version() -> str:
    with open(os.path.join(ROOT, "package.json"), encoding="utf-8") as f:
        return json.load(f)["version"]


def run_build() -> None:
    print("[1/4] 构建前端 (pnpm build)...")
    if sys.platform == "win32":
        cmd = ["pnpm.cmd", "build"]
    else:
        cmd = ["pnpm", "build"]
    r = subprocess.run(cmd, cwd=ROOT)
    if r.returncode != 0:
        sys.exit("构建失败,已中止打包")


def main() -> None:
    parser = argparse.ArgumentParser(description="打包 EpicDeck 为 Decky zip")
    parser.add_argument("--skip-build", action="store_true", help="跳过 pnpm build")
    args = parser.parse_args()

    version = read_version()
    plugin_name = "EpicDeck"
    zip_name = f"{plugin_name}-v{version}.zip"
    stage = os.path.join(ROOT, ".pkg", plugin_name)

    if not args.skip_build:
        run_build()

    # 必填文件检查
    dist_index = os.path.join(ROOT, "dist", "index.js")
    if not os.path.isfile(dist_index):
        sys.exit("缺少 dist/index.js,请先运行 pnpm build")

    print(f"[2/4] 组装包结构到 {stage}/ ...")
    if os.path.isdir(stage):
        shutil.rmtree(stage)
    os.makedirs(stage, exist_ok=True)

    # dist/index.js (必填)
    os.makedirs(os.path.join(stage, "dist"), exist_ok=True)
    shutil.copy2(dist_index, os.path.join(stage, "dist", "index.js"))

    # 根目录必填/推荐文件
    for name in ("package.json", "plugin.json", "main.py", "README.md", "LICENSE"):
        src = os.path.join(ROOT, name)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(stage, name))
        else:
            print(f"  ⚠ 警告:缺少 {name}")

    # py_modules (Python 后端模块,必填)
    py_modules = os.path.join(ROOT, "py_modules")
    if os.path.isdir(py_modules):
        shutil.copytree(
            py_modules,
            os.path.join(stage, "py_modules"),
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )

    # SECURITY.md / NOTICE (可选但推荐)
    for name in ("SECURITY.md", "NOTICE", "CONTRIBUTING.md"):
        src = os.path.join(ROOT, name)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(stage, name))

    print(f"[3/4] 压缩为 {zip_name} ...")
    out_path = os.path.join(ROOT, zip_name)
    if os.path.isfile(out_path):
        os.remove(out_path)

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for dirpath, _, filenames in os.walk(stage):
            for fn in filenames:
                full = os.path.join(dirpath, fn)
                arcname = os.path.relpath(full, os.path.join(ROOT, ".pkg"))
                zf.write(full, arcname)

    print(f"[4/4] 清理临时目录 ...")
    shutil.rmtree(os.path.join(ROOT, ".pkg"), ignore_errors=True)

    size = os.path.getsize(out_path) / 1024
    print(f"\n✅ 打包完成: {out_path} ({size:.1f} KB)")
    print(f"\n安装方式:Steam Deck 桌面模式 → Decky 开发者菜单 → Install plugin from zip")
    print(f"选择文件:{zip_name}")


if __name__ == "__main__":
    main()
