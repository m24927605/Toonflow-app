# ThorVG Windows x64 runtime library

`windowsX64/thorvg.dll` was compiled locally from unmodified official ThorVG v1.1.1 release source and is used only for software rasterization of Lottie vector animations. It uses size optimization, LTO and the 17 official C API exports in `exports.def`; the current DLL is 499,712 bytes and contains no custom rendering or API wrapper code.

- Official release: https://github.com/thorvg/thorvg/releases/tag/v1.1.1
- Source: https://github.com/thorvg/thorvg/releases/download/v1.1.1/thorvg-1.1.1.tar.xz
- Source SHA-256: `5ca6143088f18b5dbe42552c939594100da6226d79de503d1a171184d6aa310d`
- DLL SHA-256: `d3624d64950e51f6b8ac585c15d99ecce60ca926c6c5a407f8ec05830b838afc`
- Tools: Visual Studio 2022 MSVC x64 19.33.31631 (toolset directory 14.33.31629), Windows SDK 10.0.22621.0, Python 3.8, Meson 1.11.2, Ninja 1.13.2.
- `license.txt` keeps the full MIT licenses of ThorVG and of RapidJSON, which is actually enabled.

The build tools live only in the project's `work/thorvgTools` and are not installed globally. After extracting the source to `work/thorvg-1.1.1`, run the following from the repository root in a PowerShell session with the MSVC x64 environment initialized:

```powershell
python -m pip install --target work/thorvgTools meson==1.11.2 ninja==1.13.2
$env:PYTHONPATH = (Resolve-Path work/thorvgTools).Path
$env:PATH = (Resolve-Path work/thorvgTools/bin).Path + ';' + $env:PATH
python -m mesonbuild.mesonmain setup work/thorvgStaticBuild work/thorvg-1.1.1 --buildtype=release --default-library=static -Doptimization=s -Db_lto=true -Dbindings=capi -Dengines=cpu -Dloaders=lottie '-Dsavers=[]' '-Dtools=[]' -Dtests=false '-Dextra=[]' -Db_vscrt=mt -Dthreads=false -Dpartial=false -Dsimd=false -Dfile=false
python -m mesonbuild.mesonmain compile -C work/thorvgStaticBuild -j 8
link /NOLOGO /DLL /OUT:work/thorvgStaticBuild/thorvg-1.dll /DEF:packages/startup/assets/exports.def /LTCG /OPT:REF /OPT:ICF work/thorvgStaticBuild/src/libthorvg-1.a
```

Copy `work/thorvgStaticBuild/thorvg-1.dll` to `packages/startup/assets/windowsX64/thorvg.dll`, only renaming it without modifying the binary. The DLL is produced from the official static library with the standard linker and exports only the C APIs the player actually calls, so unused APIs can be stripped; the third-party animation logic is unchanged and UPX is not used. When adding new C API calls, update `exports.def` and relink.

It uses the static CRT, its import table contains only `KERNEL32.dll`, and it renders premultiplied BGRA directly on a single CPU thread; GPU, OpenMP, expressions, fonts, SVG, bitmap decoding and file I/O are not enabled. JSON is read by Bun and copied into the engine through the official C API, so no additional WebView is needed. If future assets use any of the features above, adjust loader/extra as needed and recompile.
