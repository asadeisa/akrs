/**
 * Headless scorer. Imports the (possibly agent-modified) physics modules and
 * measures objective behavior. Run: `npx tsx __score.ts <T1|T2|T3|T4|T5|base>`
 * Prints a single JSON line with metrics; the harness interprets it per task.
 *
 * This file lives at repo root (outside `src`) so it is excluded from tsc.
 */
const task = process.argv[2] ?? "base";

interface Out {
  import_ok: boolean;
  error?: string;
  energy_ratio?: number; // KE(end)/KE(start), gravity off
  signature?: number; // deterministic pos+vel sum, gravity on
  initial_gravity?: number;
  drag_field?: boolean;
  energy_drag_on?: number;
  energy_drag_off?: number;
}

async function main(): Promise<Out> {
  const { World } = await import("./src/physics/World");
  const { Body } = await import("./src/physics/Body");
  const { Vector2 } = await import("./src/math/Vector2");
  const { settings } = await import("./src/state/settings");

  // Fixed bodies on crossing paths so collisions actually fire (deterministic).
  function makeBodies(): InstanceType<typeof Body>[] {
    return [
      new Body(new Vector2(150, 300), new Vector2(180, 40), 16, "#a"),
      new Body(new Vector2(650, 300), new Vector2(-180, -40), 16, "#b"),
      new Body(new Vector2(400, 120), new Vector2(60, 170), 14, "#c"),
      new Body(new Vector2(400, 480), new Vector2(-60, -170), 14, "#d"),
    ];
  }

  const out: Out = { import_ok: true };
  out.initial_gravity = settings.gravity;
  out.drag_field = Object.prototype.hasOwnProperty.call(settings, "drag");

  // --- energy ratio (gravity off; isolates damping/friction/restitution) ---
  const savedGravity = settings.gravity;
  const savedDrag = (settings as Record<string, number>).drag;
  settings.gravity = 0;
  if (out.drag_field) (settings as Record<string, number>).drag = 0;
  {
    const w = new World();
    w.bodies = makeBodies();
    const e0 = w.totalEnergy();
    for (let i = 0; i < 3000; i++) w.step(1 / 120);
    out.energy_ratio = w.totalEnergy() / e0;
  }

  // --- T3: energy with drag on vs off ---
  if (out.drag_field) {
    for (const dragVal of [0, 1]) {
      (settings as Record<string, number>).drag = dragVal;
      const w = new World();
      w.bodies = makeBodies();
      const e0 = w.totalEnergy();
      for (let i = 0; i < 1000; i++) w.step(1 / 120);
      const r = w.totalEnergy() / e0;
      if (dragVal === 0) out.energy_drag_off = r;
      else out.energy_drag_on = r;
    }
    (settings as Record<string, number>).drag = savedDrag;
  }
  settings.gravity = savedGravity;

  // --- deterministic signature (gravity on; for T4 behavior preservation) ---
  {
    settings.gravity = 980;
    const w = new World();
    w.bodies = makeBodies();
    for (let i = 0; i < 600; i++) w.step(1 / 120);
    let sig = 0;
    for (const b of w.bodies) sig += b.pos.x + b.pos.y + b.vel.x + b.vel.y;
    out.signature = sig;
    settings.gravity = savedGravity;
  }

  return out;
}

main()
  .then((o) => console.log(JSON.stringify(o)))
  .catch((e) => console.log(JSON.stringify({ import_ok: false, error: String(e && e.message ? e.message : e) })));
void task;
