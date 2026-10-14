import { Box3, Vector3 } from "three";
import { getObjectByThreeJsonId } from "threejson/core";
import { t } from "@toonflow/i18n/vue";
import { createStage, disposeStage, type SceneDocument } from "./scene";
import { prepareSceneAnimation, type DirectorPlan } from "./sceneAnimation";
import { prepareMotion, sampleMotion } from "./motion";

// People are blocked as cylinders, or as mannequins when the user allows them.
const personTypes = new Set(["cylinder", "capsule", "mannequin"]);

/**
 * Describes where each person stands in the opening frame of a plan and where the camera is, measured in the scene, so
 * text-only models and keyframe prompts can follow the previs without seeing it: the side of the frame, the distance
 * from the camera, and the camera's height and tilt.
 */
export async function describeBlocking(scene: SceneDocument, plan: DirectorPlan, aspect: number) {
  const runtime = await createStage(document.createElement("canvas"), scene, undefined, aspect);
  const player = prepareSceneAnimation(runtime, plan);
  try {
    player.setTime(0);
    const camera = runtime.camera;
    sampleMotion(camera, prepareMotion(plan.cameraFrames), 0);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const metres = (value: number) => Number(value.toFixed(1));
    const lines = scene.objectList.filter(object => personTypes.has(object.objType)).flatMap(object => {
      const root = getObjectByThreeJsonId(object.threeJsonId, runtime.scene);
      if (!root) return [];
      root.updateMatrixWorld(true);
      const centre = new Box3().setFromObject(root).getCenter(new Vector3());
      const distance = metres(camera.position.distanceTo(centre));
      const point = centre.clone().project(camera);
      if (point.z > 1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1) return [t`${object.name}: out of frame`];
      if (point.x < -1 / 3) return [t`${object.name}: left of the frame, about ${distance} m from the camera`];
      if (point.x > 1 / 3) return [t`${object.name}: right of the frame, about ${distance} m from the camera`];
      return [t`${object.name}: centre of the frame, about ${distance} m from the camera`];
    });
    const tilt = Math.asin(camera.getWorldDirection(new Vector3()).y) * 180 / Math.PI;
    const height = metres(camera.position.y);
    lines.push(tilt < -10 ? t`camera about ${height} m high, looking down` : tilt > 10 ? t`camera about ${height} m high, looking up` : t`camera about ${height} m high, level`);
    return lines.join("; ");
  } finally {
    player.dispose();
    disposeStage(runtime);
  }
}
