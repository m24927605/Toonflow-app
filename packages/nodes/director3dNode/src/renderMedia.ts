import { createStage, disposeStage, type LightingSettings, type SceneDocument, type SceneSettings } from "./scene";
import { applyCamera, prepareMotion, sampleMotion, type CameraAnchor } from "./motion";
import { prepareSceneAnimation, type DirectorPlan } from "./sceneAnimation";
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, canEncodeVideo } from "mediabunny";
import { FloatType, GridHelper, Mesh, ShaderMaterial, ShadowMaterial, WebGLRenderTarget, type Scene } from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import type { SceneRuntime } from "threejson/core";

const frameRate = 30;
export type RenderPass = "color" | "depth";

/**
 * Renders relative inverse depth like Depth Anything (near white, far and sky black), normalized per frame, so a
 * ControlNet takes only structure and motion from the previs and none of its grey-box look.
 */
function prepareDepthPass(runtime: SceneRuntime) {
  const material = new ShaderMaterial({
    uniforms: { near: { value: 1 }, far: { value: 2 }, raw: { value: 0 } },
    vertexShader: "varying float vDistance; void main() { vec4 view = modelViewMatrix * vec4(position, 1.0); vDistance = -view.z; gl_Position = projectionMatrix * view; }",
    fragmentShader: "uniform float near; uniform float far; uniform float raw; varying float vDistance;"
      + " void main() { if (raw > 0.5) { gl_FragColor = vec4(vDistance, 0.0, 0.0, 1.0); return; }"
      + " gl_FragColor = vec4(vec3(clamp((1.0 / vDistance - 1.0 / far) / (1.0 / near - 1.0 / far), 0.0, 1.0)), 1.0); }",
  });
  const scene: Scene = runtime.scene;
  // Sky, grid and the shadow catcher are viewport aids, not geometry.
  const aids = scene.children.filter(child => child instanceof Sky || child instanceof GridHelper || (child instanceof Mesh && child.material instanceof ShadowMaterial));
  aids.forEach(child => { child.visible = false; });
  scene.background = null;
  scene.overrideMaterial = material;
  runtime.renderer.setClearColor(0x000000, 1);
  // ACT: Samples the depth range from a 128x72 float target each frame; thin objects narrower than one sample do not
  // widen the range. Raise the probe size if near detail clips to white.
  const probe = new WebGLRenderTarget(128, 72, { type: FloatType });
  const pixels = new Float32Array(128 * 72 * 4);
  return {
    render() {
      const { renderer, camera } = runtime;
      material.uniforms.raw!.value = 1;
      renderer.setRenderTarget(probe);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(probe, 0, 0, 128, 72, pixels);
      renderer.setRenderTarget(null);
      let near = Infinity;
      let far = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const distance = pixels[index]!;
        if (distance > 0) { near = Math.min(near, distance); far = Math.max(far, distance); }
      }
      if (!Number.isFinite(near) || far <= near) { near = 1; far = 2; }
      material.uniforms.near!.value = near;
      material.uniforms.far!.value = far;
      material.uniforms.raw!.value = 0;
      renderer.render(scene, camera);
    },
    dispose() { probe.dispose(); material.dispose(); },
  };
}

export async function renderImage(scene: SceneDocument, anchor: CameraAnchor, aspect: number, time: number, signal: AbortSignal, plan?: DirectorPlan, lighting?: LightingSettings, settings?: SceneSettings, pass: RenderPass = "color") {
  signal.throwIfAborted();
  const runtime = await createStage(document.createElement("canvas"), scene, undefined, aspect, lighting, settings);
  let player: ReturnType<typeof prepareSceneAnimation> | undefined;
  let depth: ReturnType<typeof prepareDepthPass> | undefined;
  try {
    signal.throwIfAborted();
    if (plan) { player = prepareSceneAnimation(runtime, plan); player.setTime(time); }
    applyCamera(runtime.camera, anchor);
    if (pass === "depth") (depth = prepareDepthPass(runtime)).render();
    else runtime.renderer.render(runtime.scene, runtime.camera);
    const blob = await new Promise<Blob>((resolve, reject) => runtime.renderer.domElement.toBlob(
      value => value ? resolve(value) : reject(new Error("关键帧渲染失败")), "image/png",
    ));
    signal.throwIfAborted();
    return new File([blob], depth ? "keyframe (depth).png" : "关键帧.png", { type: "image/png" });
  } finally { depth?.dispose(); player?.dispose(); disposeStage(runtime); }
}

export async function renderVideo(scene: SceneDocument, plan: DirectorPlan, aspect: number, signal: AbortSignal, onProgress: (value: number) => void, lighting?: LightingSettings, settings?: SceneSettings, pass: RenderPass = "color") {
  signal.throwIfAborted();
  const runtime = await createStage(document.createElement("canvas"), scene, undefined, aspect, lighting, settings);
  let player: ReturnType<typeof prepareSceneAnimation> | undefined;
  let output: Output<Mp4OutputFormat, BufferTarget> | undefined;
  let depth: ReturnType<typeof prepareDepthPass> | undefined;
  try {
    if (pass === "depth") depth = prepareDepthPass(runtime);
    const canvas = runtime.renderer.domElement;
    if (!await canEncodeVideo("avc", { width: canvas.width, height: canvas.height, frameRate })) throw new Error("当前浏览器不支持 MP4 导出，请更新浏览器");
    signal.throwIfAborted();
    player = prepareSceneAnimation(runtime, plan);
    const cameraFrames = prepareMotion(plan.cameraFrames);
    output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
    const source = new CanvasSource(canvas, { codec: "avc", quality: QUALITY_HIGH });
    output.addVideoTrack(source, { frameRate });
    await output.start();
    // Every frame is rendered at its exact plan time, so the export has a constant frame rate on any device.
    const total = Math.max(1, Math.round(plan.duration * frameRate));
    for (let index = 0; index < total; index++) {
      signal.throwIfAborted();
      const time = Math.min(plan.duration, index / frameRate);
      player.setTime(time);
      sampleMotion(runtime.camera, cameraFrames, time);
      if (depth) depth.render();
      else runtime.renderer.render(runtime.scene, runtime.camera);
      await source.add(index / frameRate, 1 / frameRate);
      onProgress(Math.min(99, Math.floor((index + 1) / total * 100)));
    }
    await output.finalize();
    signal.throwIfAborted();
    const buffer = output.target.buffer;
    if (!buffer?.byteLength) throw new Error("未能生成视频内容");
    return new File([buffer], `${plan.name}${depth ? "（深度）" : ""}.mp4`, { type: "video/mp4" });
  } finally {
    if (output && output.state !== "finalized" && output.state !== "canceled") await output.cancel();
    depth?.dispose();
    player?.dispose(); disposeStage(runtime);
  }
}
