"""Render the Amelia shard set with Blender 5.2 (headless).

    "/Applications/Blender 5.2.app/Contents/MacOS/Blender" --background \
        --python render_shards.py -- --out ../ --seed 7 --count 14 --size 512

Builds a seeded Voronoi shatter of a 2.0 x 1.2 pane in pure Python (no Cell
Fracture add-on), extrudes and bevels each cell into a glass shard, and renders
a beauty pass plus a camera-space normal pass per shard on a transparent film.
"""

import argparse
import json
import math
import os
import random
import sys
import time

import bmesh
import bpy
from mathutils import Matrix, Vector

PANE_WIDTH = 2.0
PANE_HEIGHT = 1.2
SHARD_THICKNESS = 0.04
BEVEL_WIDTH = 0.004
BEVEL_SEGMENTS = 3
MAX_TILT_DEG = 6.0
FRAME_MARGIN = 0.06
HOT_COLOR = (1.0, 0.0663, 0.0144, 1.0)  # #FF4A1C in linear
KEY_KELVIN_COLOR = (1.0, 0.914, 0.816)  # ~5000 K
RIM_COLOR = (0.58, 0.74, 1.0)
BEAUTY_VIEW_TRANSFORM = "Standard"
# Raw, not Standard: the normal pass is data, and Standard would sRGB-encode it.
NORMAL_VIEW_TRANSFORM = "Raw"
EPSILON = 1e-9


def parse_args(argv):
    parser = argparse.ArgumentParser(prog="render_shards")
    parser.add_argument("--out", required=True)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--count", type=int, default=14)
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--samples", type=int, default=256)
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--save-blend", default="")
    parser.add_argument("--only", type=int, default=0, help="render only the first N shards")
    args = parser.parse_args(argv)
    if args.preview:
        args.samples = 64
        args.size = 256
    return args


# --- Voronoi in pure Python -------------------------------------------------


def poisson_sites(rng, count):
    """Sites with a minimum separation so no cell collapses to a sliver."""
    min_gap = 0.55 * math.sqrt(PANE_WIDTH * PANE_HEIGHT / count)
    sites = []
    while len(sites) < count:
        for _ in range(400):
            candidate = (rng.uniform(0.0, PANE_WIDTH), rng.uniform(0.0, PANE_HEIGHT))
            if all(math.dist(candidate, s) >= min_gap for s in sites):
                sites.append(candidate)
                break
        else:
            min_gap *= 0.85
    return sites


def clip_half_plane(polygon, origin, direction):
    """Sutherland-Hodgman clip keeping points with dot(p - origin, direction) <= 0."""

    def side(point):
        return (point[0] - origin[0]) * direction[0] + (point[1] - origin[1]) * direction[1]

    clipped = []
    for index, current in enumerate(polygon):
        previous = polygon[index - 1]
        s_prev, s_curr = side(previous), side(current)
        if s_prev * s_curr < 0:
            t = s_prev / (s_prev - s_curr)
            clipped.append((
                previous[0] + t * (current[0] - previous[0]),
                previous[1] + t * (current[1] - previous[1]),
            ))
        if s_curr <= 0:
            clipped.append(current)
    return clipped


def voronoi_cell(site, others):
    polygon = [(0.0, 0.0), (PANE_WIDTH, 0.0), (PANE_WIDTH, PANE_HEIGHT), (0.0, PANE_HEIGHT)]
    for other in others:
        direction = (other[0] - site[0], other[1] - site[1])
        origin = ((site[0] + other[0]) * 0.5, (site[1] + other[1]) * 0.5)
        polygon = clip_half_plane(polygon, origin, direction)
        if len(polygon) < 3:
            return []
    return dedupe(polygon)


def dedupe(polygon):
    out = []
    for point in polygon:
        if not out or math.dist(point, out[-1]) > 1e-7:
            out.append(point)
    if len(out) > 2 and math.dist(out[0], out[-1]) <= 1e-7:
        out.pop()
    return out


def polygon_area(polygon):
    total = 0.0
    for index, current in enumerate(polygon):
        nxt = polygon[(index + 1) % len(polygon)]
        total += current[0] * nxt[1] - nxt[0] * current[1]
    return abs(total) * 0.5


def polygon_centroid(polygon):
    area_sum = 0.0
    cx = cy = 0.0
    for index, current in enumerate(polygon):
        nxt = polygon[(index + 1) % len(polygon)]
        cross = current[0] * nxt[1] - nxt[0] * current[1]
        area_sum += cross
        cx += (current[0] + nxt[0]) * cross
        cy += (current[1] + nxt[1]) * cross
    if abs(area_sum) < EPSILON:
        return (sum(p[0] for p in polygon) / len(polygon), sum(p[1] for p in polygon) / len(polygon))
    return (cx / (3.0 * area_sum), cy / (3.0 * area_sum))


def shatter(seed, count):
    rng = random.Random(seed)
    sites = poisson_sites(rng, count)
    cells = []
    for index, site in enumerate(sites):
        polygon = voronoi_cell(site, [s for i, s in enumerate(sites) if i != index])
        if len(polygon) < 3 or polygon_area(polygon) < 1e-4:
            continue
        axis_angle = rng.uniform(0.0, math.tau)
        cells.append({
            "polygon": polygon,
            "centroid": polygon_centroid(polygon),
            "area": polygon_area(polygon),
            "tilt_deg": rng.uniform(1.0, MAX_TILT_DEG),
            "tilt_axis": (math.cos(axis_angle), math.sin(axis_angle), 0.0),
            "hot_phase": rng.uniform(0.0, math.tau),
        })
    cells.sort(key=lambda cell: (round(cell["centroid"][1], 5), cell["centroid"][0]))
    return cells


# --- Scene construction -----------------------------------------------------


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.objects, bpy.data.lights):
        for datablock in list(collection):
            collection.remove(datablock)


def build_shard_object(cell, index):
    mesh = bpy.data.meshes.new(f"shard-{index:02d}")
    bm = bmesh.new()
    verts = [bm.verts.new((x, y, SHARD_THICKNESS * 0.5)) for x, y in cell["polygon"]]
    face = bm.faces.new(verts)
    if face.normal.z < 0:
        face.normal_flip()
    extruded = bmesh.ops.extrude_face_region(bm, geom=[face])
    moved = [element for element in extruded["geom"] if isinstance(element, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=moved, vec=(0.0, 0.0, -SHARD_THICKNESS))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()

    obj = bpy.data.objects.new(f"shard-{index:02d}", mesh)
    bpy.context.scene.collection.objects.link(obj)
    apply_tilt(obj, cell)
    bevel = obj.modifiers.new("Bevel", "BEVEL")
    bevel.width = BEVEL_WIDTH
    bevel.segments = BEVEL_SEGMENTS
    bevel.limit_method = "ANGLE"
    bevel.angle_limit = math.radians(25.0)
    bevel.harden_normals = False
    return obj


def apply_tilt(obj, cell):
    pivot = Vector((cell["centroid"][0], cell["centroid"][1], 0.0))
    tilt = Matrix.Rotation(math.radians(cell["tilt_deg"]), 4, Vector(cell["tilt_axis"]))
    for vertex in obj.data.vertices:
        vertex.co = tilt @ (vertex.co - pivot) + pivot


def glass_material():
    mat = bpy.data.materials.new("shard-glass")
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.97, 0.945, 0.92, 1.0)
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Transmission Weight"].default_value = 1.0
    bsdf.inputs["IOR"].default_value = 1.5
    bsdf.inputs["Specular IOR Level"].default_value = 0.6

    roughness_noise = nodes.new("ShaderNodeTexNoise")
    roughness_noise.inputs["Scale"].default_value = 9.0
    roughness_noise.inputs["Detail"].default_value = 3.0
    roughness_noise.inputs["Roughness"].default_value = 0.5
    roughness_range = nodes.new("ShaderNodeMapRange")
    roughness_range.inputs["From Min"].default_value = 0.25
    roughness_range.inputs["From Max"].default_value = 0.75
    roughness_range.inputs["To Min"].default_value = 0.008
    roughness_range.inputs["To Max"].default_value = 0.045
    roughness_range.clamp = True
    links.new(roughness_noise.outputs["Factor"], roughness_range.inputs["Value"])
    links.new(roughness_range.outputs["Result"], bsdf.inputs["Roughness"])

    swell = add_bump(nodes, links, scale=4.0, detail=2.0, strength=0.24, distance=0.006)
    scratch = add_bump(nodes, links, scale=130.0, detail=5.0, strength=0.022, distance=0.005)
    links.new(swell.outputs["Normal"], scratch.inputs["Normal"])
    links.new(scratch.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


def add_bump(nodes, links, scale, detail, strength, distance):
    """Noise-driven surface relief: a slow swell plus fine micro-scratches."""
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = scale
    noise.inputs["Detail"].default_value = detail
    noise.inputs["Roughness"].default_value = 0.6
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = strength
    bump.inputs["Distance"].default_value = distance
    links.new(noise.outputs["Factor"], bump.inputs["Height"])
    return bump


def normal_material():
    mat = bpy.data.materials.new("shard-normal")
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    for node in list(nodes):
        if node.type != "OUTPUT_MATERIAL":
            nodes.remove(node)
    output = nodes["Material Output"]

    geometry = nodes.new("ShaderNodeNewGeometry")
    transform = nodes.new("ShaderNodeVectorTransform")
    transform.vector_type = "NORMAL"
    transform.convert_from = "WORLD"
    transform.convert_to = "CAMERA"
    # Blender's camera space points +Z into the scene; flip it so a face turned
    # towards the camera encodes as the usual (0.5, 0.5, 1.0).
    face_camera = nodes.new("ShaderNodeVectorMath")
    face_camera.operation = "MULTIPLY"
    face_camera.inputs[1].default_value = (1.0, 1.0, -1.0)
    remap = nodes.new("ShaderNodeMapRange")
    remap.data_type = "FLOAT_VECTOR"
    remap.clamp = True
    remap.inputs[7].default_value = (-1.0, -1.0, -1.0)
    remap.inputs[8].default_value = (1.0, 1.0, 1.0)
    remap.inputs[9].default_value = (0.0, 0.0, 0.0)
    remap.inputs[10].default_value = (1.0, 1.0, 1.0)
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Strength"].default_value = 1.0

    links.new(geometry.outputs["Normal"], transform.inputs["Vector"])
    links.new(transform.outputs["Vector"], face_camera.inputs[0])
    links.new(face_camera.outputs["Vector"], remap.inputs[6])
    links.new(remap.outputs["Vector"], emission.inputs["Color"])
    links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return mat


def look_at(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def hot_panel_material():
    """The #FF4A1C panel the shards refract, ramped so the hot light has structure."""
    mat = bpy.data.materials.new("hot-panel")
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    for node in list(nodes):
        if node.type != "OUTPUT_MATERIAL":
            nodes.remove(node)

    coords = nodes.new("ShaderNodeTexCoord")
    gradient = nodes.new("ShaderNodeTexGradient")
    gradient.gradient_type = "LINEAR"
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "EASE"
    ramp.color_ramp.elements[0].position = 0.42
    ramp.color_ramp.elements[0].color = (0.0, 0.0, 0.0, 1.0)
    ramp.color_ramp.elements[1].position = 0.80
    ramp.color_ramp.elements[1].color = (1.0, 1.0, 1.0, 1.0)

    colour_ramp = nodes.new("ShaderNodeValToRGB")
    colour_ramp.color_ramp.interpolation = "EASE"
    colour_ramp.color_ramp.elements[0].position = 0.0
    colour_ramp.color_ramp.elements[0].color = (0.55, 0.030, 0.008, 1.0)
    colour_ramp.color_ramp.elements[1].position = 0.78
    colour_ramp.color_ramp.elements[1].color = HOT_COLOR

    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Strength"].default_value = 6.5
    transparent = nodes.new("ShaderNodeBsdfTransparent")
    mix = nodes.new("ShaderNodeMixShader")

    links.new(coords.outputs["Generated"], gradient.inputs["Vector"])
    links.new(gradient.outputs["Fac"], ramp.inputs["Fac"])
    links.new(gradient.outputs["Fac"], colour_ramp.inputs["Fac"])
    links.new(colour_ramp.outputs["Color"], emission.inputs["Color"])
    links.new(ramp.outputs["Color"], mix.inputs["Fac"])
    links.new(transparent.outputs["BSDF"], mix.inputs[1])
    links.new(emission.outputs["Emission"], mix.inputs[2])
    links.new(mix.outputs["Shader"], nodes["Material Output"].inputs["Surface"])
    return mat


def build_world():
    """A soft studio gradient. film_transparent hides it from camera rays, but
    rays that refract through the glass still pick it up, so shards read as glass
    rather than black cut-outs."""
    world = bpy.data.worlds.new("studio")
    bpy.context.scene.world = world
    world.use_nodes = True
    nodes, links = world.node_tree.nodes, world.node_tree.links
    for node in list(nodes):
        if node.type != "OUTPUT_WORLD":
            nodes.remove(node)
    coords = nodes.new("ShaderNodeTexCoord")
    separate = nodes.new("ShaderNodeSeparateXYZ")
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "EASE"
    ramp.color_ramp.elements[0].position = 0.18
    ramp.color_ramp.elements[0].color = (0.035, 0.033, 0.036, 1.0)
    ramp.color_ramp.elements[1].position = 0.88
    ramp.color_ramp.elements[1].color = (0.62, 0.645, 0.70, 1.0)
    background = nodes.new("ShaderNodeBackground")
    background.inputs["Strength"].default_value = 1.0
    links.new(coords.outputs["Generated"], separate.inputs["Vector"])
    links.new(separate.outputs["Z"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], background.inputs["Color"])
    links.new(background.outputs["Background"], nodes["World Output"].inputs["Surface"])
    return world


def build_rig():
    scene = bpy.context.scene

    camera_data = bpy.data.cameras.new("cam")
    camera_data.type = "ORTHO"
    camera_data.clip_start = 0.01
    camera_data.clip_end = 20.0
    camera = bpy.data.objects.new("cam", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera

    key = bpy.data.objects.new("key", bpy.data.lights.new("key", "AREA"))
    key.data.color = KEY_KELVIN_COLOR
    key.data.shape = "RECTANGLE"
    scene.collection.objects.link(key)

    rim = bpy.data.objects.new("rim", bpy.data.lights.new("rim", "AREA"))
    rim.data.color = RIM_COLOR
    scene.collection.objects.link(rim)

    hot = bpy.data.meshes.new("hot")
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=0.5)
    bm.to_mesh(hot)
    bm.free()
    hot_obj = bpy.data.objects.new("hot", hot)
    scene.collection.objects.link(hot_obj)
    hot.materials.append(hot_panel_material())

    for obj in (key, rim, hot_obj):
        obj.visible_camera = False
    return {"camera": camera, "key": key, "rim": rim, "hot": hot_obj}


def place_rig(rig, centre, extent, hot_phase):
    """Position camera and lights relative to the shard so every render matches."""
    cx, cy = centre
    s = extent / 0.5

    rig["camera"].location = (cx, cy, 3.0)
    rig["camera"].rotation_euler = (0.0, 0.0, 0.0)
    rig["camera"].data.ortho_scale = extent

    rig["key"].location = (cx - 0.95 * s, cy + 1.05 * s, 4.3 * s)
    rig["key"].data.size = 0.55 * s
    rig["key"].data.size_y = 0.14 * s
    rig["key"].data.energy = 900.0 * s * s
    look_at(rig["key"], (cx, cy, 0.0))

    rig["rim"].location = (cx + 1.9 * s, cy - 2.1 * s, -2.6 * s)
    rig["rim"].data.size = 2.6 * s
    rig["rim"].data.energy = 430.0 * s * s
    look_at(rig["rim"], (cx, cy, 0.0))

    radius = 0.12 * s
    rig["hot"].location = (
        cx + radius * math.cos(hot_phase),
        cy + radius * math.sin(hot_phase),
        -1.6 * s,
    )
    rig["hot"].rotation_euler = (0.0, 0.0, hot_phase)
    rig["hot"].scale = (3.2 * s, 3.2 * s, 1.0)
    look_at(rig["hot"], (cx, cy, 0.0))
    rig["hot"].rotation_euler.rotate_axis("Z", hot_phase)
    look_at(rig["hot"], (cx, cy, 0.0))


def configure_render(args):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.render.resolution_x = args.size
    scene.render.resolution_y = args.size
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "16"
    scene.render.image_settings.compression = 15
    scene.cycles.samples = args.samples
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.01
    scene.cycles.max_bounces = 24
    scene.cycles.transmission_bounces = 20
    scene.cycles.transparent_max_bounces = 24
    scene.cycles.use_denoising = True
    scene.cycles.caustics_refractive = True
    scene.cycles.caustics_reflective = True
    return select_device()


def select_device():
    scene = bpy.context.scene
    try:
        preferences = bpy.context.preferences.addons["cycles"].preferences
        preferences.compute_device_type = "METAL"
        preferences.get_devices()
        gpus = [device for device in preferences.devices if device.type == "METAL"]
        for device in preferences.devices:
            device.use = device.type == "METAL"
        if gpus:
            scene.cycles.device = "GPU"
            return f"METAL ({gpus[0].name})"
    except Exception as error:  # pragma: no cover - depends on the host machine
        print(f"[shards] Metal unavailable, falling back to CPU: {error}")
    scene.cycles.device = "CPU"
    return "CPU"


# --- Rendering --------------------------------------------------------------


def bounds_of(obj):
    xs = [(obj.matrix_world @ vertex.co).x for vertex in obj.data.vertices]
    ys = [(obj.matrix_world @ vertex.co).y for vertex in obj.data.vertices]
    return min(xs), min(ys), max(xs), max(ys)


def render_to(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def set_visible(objects, visible_obj):
    for obj in objects:
        obj.hide_render = obj is not visible_obj


def assign(objects, material):
    for obj in objects:
        obj.data.materials.clear()
        obj.data.materials.append(material)


def render_pass(scene, samples, denoise, view_transform):
    scene.cycles.samples = samples
    scene.cycles.use_denoising = denoise
    scene.view_settings.view_transform = view_transform


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    args = parse_args(argv)
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)

    reset_scene()
    device = configure_render(args)
    print(f"[shards] device: {device}")

    cells = shatter(args.seed, args.count)
    glass, normals = glass_material(), normal_material()
    shards = []
    for index, cell in enumerate(cells, start=1):
        obj = build_shard_object(cell, index)
        obj.data.materials.append(glass)
        shards.append(obj)

    build_world()
    rig = build_rig()
    scene = bpy.context.scene
    started = time.time()
    entries = []
    limit = args.only or len(shards)

    for index, obj in enumerate(shards[:limit], start=1):
        cell = cells[index - 1]
        min_x, min_y, max_x, max_y = bounds_of(obj)
        extent = max(max_x - min_x, max_y - min_y) * (1.0 + 2.0 * FRAME_MARGIN)
        centre = ((min_x + max_x) * 0.5, (min_y + max_y) * 0.5)
        place_rig(rig, centre, extent, cell["hot_phase"])
        set_visible(shards, obj)

        name = f"shard-{index:02d}"
        assign(shards, glass)
        render_pass(scene, args.samples, True, BEAUTY_VIEW_TRANSFORM)
        render_to(os.path.join(out_dir, f"{name}.png"))

        assign(shards, normals)
        render_pass(scene, 16, False, NORMAL_VIEW_TRANSFORM)
        render_to(os.path.join(out_dir, f"{name}-normal.png"))
        assign(shards, glass)

        entries.append({
            "id": name,
            "index": index,
            "beauty": f"{name}.png",
            "normal": f"{name}-normal.png",
            "pixel_size": [args.size, args.size],
            "centroid": [cell["centroid"][0] / PANE_WIDTH, cell["centroid"][1] / PANE_HEIGHT],
            "polygon": [[x / PANE_WIDTH, y / PANE_HEIGHT] for x, y in cell["polygon"]],
            "area": cell["area"] / (PANE_WIDTH * PANE_HEIGHT),
            "tilt": round(cell["tilt_deg"], 3),
            "frame_extent": round(extent, 5),
        })
        print(f"[shards] {name} done ({time.time() - started:.1f}s elapsed)")

    elapsed = time.time() - started
    manifest = {
        "seed": args.seed,
        "count": len(entries),
        "pane": [PANE_WIDTH, PANE_HEIGHT],
        "thickness": SHARD_THICKNESS,
        "size": args.size,
        "samples": args.samples,
        "device": device,
        "render_seconds": round(elapsed, 1),
        "shards": entries,
    }
    with open(os.path.join(out_dir, "manifest.json"), "w") as handle:
        json.dump(manifest, handle, indent=2)
    if args.save_blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.save_blend))
    print(f"[shards] {len(entries)} shards in {elapsed:.1f}s on {device}")


if __name__ == "__main__":
    main()
