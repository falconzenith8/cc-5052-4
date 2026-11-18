// Shared math helpers. Vectors are [x,y,z]; quaternions are [x,y,z,w].

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  length: (a) => Math.hypot(a[0], a[1], a[2]),
  normalize(a) {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l < 1e-12 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
  },
  isFinite(a) {
    return Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
  },
};

export const quat = {
  identity: () => [0, 0, 0, 1],

  normalize(q0) {
    const l = Math.hypot(q0[0], q0[1], q0[2], q0[3]) || 1;
    return [q0[0] / l, q0[1] / l, q0[2] / l, q0[3] / l];
  },

  // Hamilton product a * b
  multiply(a, b) {
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz,
    ];
  },

  conjugate(q0) {
    return [-q0[0], -q0[1], -q0[2], q0[3]];
  },

  fromAxisAngle(axis, angle) {
    const [x, y, z] = v3.normalize(axis);
    const h = angle / 2;
    const s = Math.sin(h);
    return [x * s, y * s, z * s, Math.cos(h)];
  },

  rotateVec(q0, v) {
    const [x, y, z, w] = q0;
    const t = v3.scale(v3.cross([x, y, z], v), 2);
    const qv = [x, y, z];
    return v3.add(v3.add(v, v3.scale(t, w)), v3.cross(qv, t));
  },

  slerp(a, b, t) {
    const qa = quat.normalize(a);
    let qb = quat.normalize(b);
    let dot = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3];
    if (dot < 0) {
      qb = [-qb[0], -qb[1], -qb[2], -qb[3]];
      dot = -dot;
    }
    if (dot > 0.9995) {
      return quat.normalize([
        qa[0] + (qb[0] - qa[0]) * t,
        qa[1] + (qb[1] - qa[1]) * t,
        qa[2] + (qb[2] - qa[2]) * t,
        qa[3] + (qb[3] - qa[3]) * t,
      ]);
    }
    const theta0 = Math.acos(clamp(dot, -1, 1));
    const theta = theta0 * t;
    const sinTheta0 = Math.sin(theta0);
    const s1 = Math.cos(theta) - (dot * Math.sin(theta)) / sinTheta0;
    const s2 = Math.sin(theta) / sinTheta0;
    return quat.normalize([
      qa[0] * s1 + qb[0] * s2,
      qa[1] * s1 + qb[1] * s2,
      qa[2] * s1 + qb[2] * s2,
      qa[3] * s1 + qb[3] * s2,
    ]);
  },

  // Angular velocity that rotates q0 into q1 over dt (rad/s, world axis).
  deltaAngularVelocity(q0, q1, dt) {
    const dq = quat.normalize(quat.multiply(q1, quat.conjugate(q0)));
    const w = clamp(dq[3], -1, 1);
    const angle = 2 * Math.acos(w);
    if (angle < 1e-8) return [0, 0, 0];
    const s = Math.sin(angle / 2);
    const axis = [dq[0] / s, dq[1] / s, dq[2] / s];
    return v3.scale(axis, angle / dt);
  },
};
