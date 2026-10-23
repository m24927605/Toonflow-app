import { Box3, Vector3, type Mesh, type Object3D } from "three";

/** Measure along the proxy's own vertical axis, including its posed child geometry. */
export function personPoints(root: Object3D, fractions: number[]) {
  root.updateWorldMatrix(true, true);
  const inverse = root.matrixWorld.clone().invert();
  const bounds = new Box3();
  root.traverse(object => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    if (mesh.geometry.boundingBox) bounds.union(mesh.geometry.boundingBox.clone().applyMatrix4(inverse.clone().multiply(mesh.matrixWorld)));
  });
  if (bounds.isEmpty()) throw new Error("Cannot measure a person proxy without geometry");
  const centre = bounds.getCenter(new Vector3());
  return fractions.map(fraction => new Vector3(centre.x, bounds.min.y + (bounds.max.y - bounds.min.y) * fraction, centre.z).applyMatrix4(root.matrixWorld));
}
