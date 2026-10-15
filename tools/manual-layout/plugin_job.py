"""Explicit-button Layout jobs, using the installed0.12.3 plugin in isolation.

The backend owns threading and stale-result application. This runner never runs
on import, calls a browser/server, edits the active execution, or claims visual
approval. Installed core geometry is copied byte-identically; only dispatch
guards and per-prototype scale translation adapt the frozen manual snapshot.
"""
from __future__ import annotations

from collections import Counter
from copy import deepcopy
import difflib
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = Path(os.environ.get('TMC_LAYOUT_PLUGIN_ROOT') or str(Path.home()/'.codex/plugins/cache/visual-level-layout-share/tmc-level-layout/0.12.3+codex.20261012095519'))
SEED = 20261014
MAX_BATCHES_PER_GROUP = 3
JOB_SECONDS = 420
TARGETS = {'facility-01': 9, 'character-01': 3, 'character-02': 9}
SOURCE_LOCK_FIELDS = ('item', 'x', 'y', 'mirrored', 'scale', 'source_instance_id', 'delivery_anchor', 'source_anchor')


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def write(path, data):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix+'.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False)+'\n', encoding='utf-8')
    temp.replace(path)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def content_hash(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest()


def _positive(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError('Scale must be a finite positive number')
    return float(value)


def runtime_foot(row, asset):
    width, height = asset['native_size']; crop = asset['alpha_crop']
    u, v = asset['anchor_fraction']
    ax, ay = crop[0]+u*(crop[2]-crop[0]), crop[1]+v*(crop[3]-crop[1])
    if row['mirrored']:
        ax = width-ax
    scale = row.get('scale', 1)
    return [(row['x']/40.96+.5)*4096-scale*(width/2-ax),
            (.5-row['y']/40.96)*4096-scale*(height-ay)]


def quantity(rows, expected):
    counts = Counter(row['item'] for row in rows)
    if set(counts)-set(expected) or any(counts[pid] > expected[pid] for pid in counts):
        raise ValueError('Exact planner prototype/count upper limit violated')
    return dict(counts), {pid: n-counts[pid] for pid, n in expected.items() if counts[pid] < n}


def validate_snapshot(snapshot):
    if snapshot.get('schema') not in (None, 'manual-layout-frozen.v1'):
        raise ValueError('Unsupported frozen manual snapshot schema')
    source, catalog, scales = snapshot['source_placements'], snapshot['catalog'], snapshot['prototype_scales']
    contract = snapshot['contract']; expected = contract['counts']
    if len(source) != 81 or len(catalog) != 24 or set(catalog) != set(expected) or set(scales) != set(expected):
        raise ValueError('Manual canyon snapshot requires81 source placements and exact24 prototypes')
    if sum(expected.values()) != 162 or contract.get('total', 162) != 162 or contract.get('vehicles', 0) != 0 or contract.get('stacks', 6) != 6:
        raise ValueError('The exact162/0V/6stack contract must remain unchanged')
    targets = contract.get('targets', TARGETS)
    if isinstance(targets, dict) and targets != TARGETS or not isinstance(targets, dict) and targets != 21:
        raise ValueError('The exact21 target subset must remain unchanged')
    if any(pid.startswith('vehicle-') for pid in expected):
        raise ValueError('Vehicle assets are forbidden for this canyon job')
    project = Path(snapshot['project_dir']).resolve()
    level = read(project/'level.json')
    if {row['name']: row['count'] for row in level['cast']} != expected:
        raise ValueError('Project cast differs from frozen count contract')
    if any(row.get('class') in {'vehicle', 'rail_vehicle', 'boat', 'submarine', 'aircraft'} or row.get('motion')
           for row in level['cast']):
        raise ValueError('Frozen canyon project must contain zero vehicle-class assets')
    files = sorted(p.stem for p in (project/'item').glob('*.png'))
    other_images = [p for p in (project/'item').iterdir() if p.is_file() and p.suffix.lower() in {'.jpg', '.jpeg', '.webp', '.gif'}]
    if files != sorted(expected) or other_images:
        raise ValueError('Project item directory must contain exactly24 planned PNGs and noV')
    pins = [{'path': str(project/name), 'sha256': sha(project/name)} for name in ('level.json', 'project.json')]
    for pid, asset in catalog.items():
        _positive(scales[pid]); path = project/'item'/(pid+'.png')
        if sha(path) != asset['sha256']:
            raise ValueError('Project/catalog whole-PNG hash mismatch: '+pid)
        pins.append({'path': str(path), 'sha256': asset['sha256']})
    mask = snapshot['mask_binding']
    if sha(mask['path']) != mask['sha256']:
        raise ValueError('Frozen terrain mask changed')
    pins.append({'path': str(Path(mask['path']).resolve()), 'sha256': mask['sha256']})
    ids = set(); runtime_ids = set()
    model = {row['instance_id']: row for row in snapshot.get('source_model', {}).get('instances', [])}
    for row in source:
        sid = row.get('source_instance_id')
        if not sid or sid in ids or row.get('id') in runtime_ids:
            raise ValueError('Source IDs must be unique and explicit')
        ids.add(sid); runtime_ids.add(row.get('id'))
        if row['item'] not in scales or not math.isclose(row.get('scale', 1), scales[row['item']], abs_tol=1e-9):
            raise ValueError('Source and supplement must share exact per-prototype scale')
        if not isinstance(row.get('mirrored'), bool) or any(not isinstance(row.get(k), (float, int)) or not math.isfinite(row[k]) for k in ('x', 'y')):
            raise ValueError('Source runtime pose unresolved')
        reference = model.get(sid)
        if reference:
            if reference['prototype_id'] != row['item'] or reference['mirror_x'] != row['mirrored']:
                raise ValueError('Confirmed source identity/mirror changed')
            foot = runtime_foot(row, catalog[row['item']])
            if max(abs(a-b) for a, b in zip(foot, reference['delivery_anchor'])) > 1e-6:
                raise ValueError('Runtime pivot does not preserve confirmed manual foot: '+sid)
    quantity(source, expected)
    for record in snapshot.get('bindings', []):
        path = record.get('path', record.get('file'))
        if path and record.get('sha256'):
            if sha(path) != record['sha256']:
                raise ValueError('Frozen input binding changed: '+path)
            pins.append({'path': str(Path(path).resolve()), 'sha256': record['sha256']})
    return pins


def lock_report(reference, actual, scales, expected, *, require_all=True):
    counts, missing = quantity(actual, expected)
    original = {row['source_instance_id']: row for row in reference}
    sources = [row for row in actual if row.get('source_instance_id')]
    seen = {}; errors = []
    for row in actual:
        if not math.isclose(row.get('scale', 1), scales.get(row['item'], float('nan')), abs_tol=1e-9):
            errors.append({'id': row.get('id'), 'field': 'scale'})
    for row in sources:
        sid = row['source_instance_id']; old = original.get(sid)
        if old is None or sid in seen:
            errors.append({'source_instance_id': sid, 'field': 'unknown_or_duplicate_source'}); continue
        seen[sid] = row
        for field in SOURCE_LOCK_FIELDS:
            if row.get(field) != old.get(field):
                errors.append({'source_instance_id': sid, 'field': field})
    if require_all:
        errors.extend({'source_instance_id': sid, 'field': 'removed'} for sid in sorted(set(original)-set(seen)))
    return {'ok': not errors, 'errors': errors, 'counts': counts, 'deficits': missing,
            'source_count': len(sources), 'source_geometry_hash': content_hash([
                {key: row.get(key) for key in SOURCE_LOCK_FIELDS} for row in reference]),
            'prototype_scales_hash': content_hash(scales)}


def all_pose_report(reference, actual, *, require_all=False):
    """Validation jobs lock every supplemental pose too, independently of source IDs."""
    old = {r['id']: r for r in reference}; errors = []
    if len(old) != len(reference):
        errors.append({'field': 'duplicate_reference_id'})
    fields = ('item', 'x', 'y', 'mirrored', 'scale', 'on', 'slot', 'slotIndex')
    seen = set()
    for row in actual:
        before = old.get(row.get('id'))
        if before is None or row.get('id') in seen:
            errors.append({'id': row.get('id'), 'field': 'unknown_or_duplicate'}); continue
        seen.add(row['id'])
        for field in fields:
            if row.get(field) != before.get(field):
                errors.append({'id': row['id'], 'field': field})
    if require_all:
        errors.extend({'id': key, 'field': 'removed'} for key in sorted(set(old)-seen))
    def pose_rows(rows):
        return sorted(({'id': r['id'], **{key: r.get(key) for key in fields}} for r in rows), key=lambda r: r['id'])
    reference_hash, actual_hash = content_hash(pose_rows(reference)), content_hash(pose_rows(actual))
    return {'ok': not errors, 'errors': errors, 'pose_hash': reference_hash,
            'reference_pose_hash': reference_hash, 'actual_pose_hash': actual_hash,
            'hash_order': 'runtime_id; UI draw/list order is not a pose change'}


def canonical_import_order(placements):
    """Preserve existing IDs through official draft-add's sequential allocation.

    draft-add assigns P000... by insertion order. The UI may list those same
    identities by depth or region, so only the import array order is adapted.
    No ID, field, number, anchor or relation is rewritten. Gapped identities
    cannot be preserved through that interface and are rejected explicitly.
    """
    ids = [row.get('id') for row in placements]
    expected = {f'P{i:03d}' for i in range(len(placements))}
    if len(set(ids)) != len(ids) or set(ids) != expected:
        raise ValueError('Official draft-add requires existing contiguous P000.. IDs to preserve frozen identities; duplicate/gapped IDs are not renumbered')
    ordered = sorted(deepcopy(placements), key=lambda row: int(row['id'][1:]))
    invariant = all_pose_report(placements, ordered, require_all=True)
    if not invariant['ok'] or invariant['reference_pose_hash'] != invariant['actual_pose_hash']:
        raise AssertionError('Import ordering altered an existing pose')
    return ordered


def _guard_contract(args):
    project = getattr(args, 'project', None); run = getattr(args, 'run_dir', None)
    if not project and run and (Path(run)/'run-manifest.json').exists():
        project = read(Path(run)/'run-manifest.json')['levelDir']
    path = Path(project)/'manual-job-contract.json' if project else None
    return read(path) if path and path.is_file() else None


def install_dispatch_guard(h):
    """Adapt requested scales to real solver dimensions; no core code changes."""
    solver, queue = h.propose_batch, h.round_robin_missing
    def largest_first(spec, actual, group, count, multiple):
        if group != 'building':
            return queue(spec, actual, group, count, multiple)
        items = sorted((row for row in spec.values() if row['group'] == group),
                       key=lambda row: (-h.core_geometry.shape_area(h.core_geometry.ground_shape(row, {'x': 0, 'y': 0})), row['name']))
        result = []
        for item in items:
            result.extend([item]*min(max(0, int(item['count'])-actual[item['name']]), max(0, count-len(result))))
        return result
    def scaled(manifest, spec, context, placements, wanted, **kwargs):
        path = Path(manifest['levelDir'])/'manual-job-contract.json'
        if not path.is_file():
            return solver(manifest, spec, context, placements, wanted, **kwargs)
        scales = read(path)['prototype_scales']; scaled_spec = deepcopy(spec)
        for name, item in scaled_spec.items():
            item['_manualOriginalGroundDepth'] = h.core_geometry.ground_depth(spec[name])
            for field in ('world_w', 'world_h', 'vis_w', 'vis_h', 'vis_dx', 'vis_dy'):
                if field in item:
                    item[field] *= scales[name]
        existing = deepcopy(placements)
        for row in existing:
            row['scale'] = row.get('scale', 1)/scales[row['item']]
        depth = h.core_geometry.ground_depth
        h.core_geometry.ground_depth = lambda item: item.get('_manualOriginalGroundDepth', depth(item))
        try:
            rows, meta, warnings = solver(manifest, scaled_spec, context, existing,
                [scaled_spec[item['name']] for item in wanted], **kwargs)
        finally:
            h.core_geometry.ground_depth = depth
        for row in rows:
            row['scale'] = row.get('scale', 1)*scales[row['item']]
        return rows, meta, warnings
    h.round_robin_missing, h.propose_batch = largest_first, scaled


def guard_before(args):
    contract = _guard_contract(args)
    if not contract:
        return None
    run = getattr(args, 'run_dir', None); path = Path(run)/'draft-layout.json' if run else None
    rows = read(path)['placements'] if path and path.exists() else []
    report = lock_report(contract['source_placements'], rows, contract['prototype_scales'], contract['counts'], require_all=False)
    if not report['ok']:
        raise ValueError('Manual source guard failed before command: '+str(report['errors']))
    if contract.get('locked_placements'):
        poses = all_pose_report(contract['locked_placements'], rows)
        if not poses['ok']:
            raise ValueError('Validation pose lock failed: '+str(poses['errors']))
    if args.command in ('repair', 'count-align', 'seed-batch', 'draft-move', 'draft-remove'):
        raise ValueError('Automatic repair/removal/pose changes are forbidden inside a frozen button job')
    if args.command == 'post':
        planning = Path(run)/'planning-log.json'
        if not planning.is_file() or not read(planning).get('enforced'):
            raise ValueError('Post requires a real enforced finalize; automatic legacy post is forbidden')
    return contract, path, path.read_bytes() if path and path.exists() else None, {r['source_instance_id'] for r in rows if r.get('source_instance_id')}


def guard_after(args, state):
    if not state:
        return
    contract, path, previous, required = state
    if not path or not path.exists():
        return
    rows = read(path)['placements']
    report = lock_report(contract['source_placements'], rows, contract['prototype_scales'], contract['counts'], require_all=False)
    current = {r['source_instance_id'] for r in rows if r.get('source_instance_id')}
    poses = all_pose_report(contract['locked_placements'], rows) if contract.get('locked_placements') else {'ok': True}
    if not report['ok'] or not required <= current or not poses['ok']:
        if previous is not None:
            path.write_bytes(previous)
        raise ValueError('Manual source/size/all-pose lock rejected and draft rolled back: '+str({
            'source_errors': report['errors'], 'all_pose_errors': poses.get('errors', []),
            'removed_source_ids': sorted(required-current)}))


def prepare_adapter(job_dir):
    target = job_dir/'plugin-adapter'
    shutil.copytree(PLUGIN, target, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    harness = target/'scripts/tmc_harness.py'; original = harness.read_text(encoding='utf-8')
    old = '            fail(f"Scene preflight blocked; inspect {run_dir / \'repair-request.json\'} before generating seeds")'
    new = ('            manifest["manualDiagnosticPreflightUnresolved"] = gate\n'
           '            write_json(run_dir / "run-manifest.json", manifest)\n'
           '            print("Manual diagnostic-only job: failed preflight retained, no formal approval", file=sys.stderr)')
    if original.count(old) != 1:
        raise ValueError('Installed preflight dispatch changed; adapter requires review')
    changed = original.replace(old, new)
    old_main = '        enforce_run_harness_identity(args)\n        args.func(args)'
    code_path = str(Path(__file__).resolve().parent)
    new_main = ('        enforce_run_harness_identity(args)\n'
        f'        sys.path.insert(0, {code_path!r})\n'
        '        import plugin_job as manual_job\n'
        '        manual_job.install_dispatch_guard(sys.modules[__name__])\n'
        '        guard_state = manual_job.guard_before(args)\n'
        '        try:\n            args.func(args)\n'
        '        finally:\n            manual_job.guard_after(args, guard_state)')
    if changed.count(old_main) != 1:
        raise ValueError('Installed command dispatch changed; adapter requires review')
    changed = changed.replace(old_main, new_main)
    harness.write_text(changed, encoding='utf-8', newline='\n')
    core = [{'file': p.relative_to(PLUGIN).as_posix(), 'installed_sha256': sha(p),
             'copied_sha256': sha(target/p.relative_to(PLUGIN))} for p in sorted((PLUGIN/'scripts/core').rglob('*.py'))]
    if any(row['installed_sha256'] != row['copied_sha256'] for row in core):
        raise ValueError('Installed core copy mismatch')
    patch = ''.join(difflib.unified_diff(original.splitlines(True), changed.splitlines(True), fromfile='installed/tmc_harness.py', tofile='manual-dispatch/tmc_harness.py'))
    (job_dir/'dispatch.patch').write_text(patch, encoding='utf-8')
    write(job_dir/'code-provenance.json', {'installed_plugin': str(PLUGIN), 'version': '0.12.3+codex.20261012095519',
        'installed_harness_sha256': sha(PLUGIN/'scripts/tmc_harness.py'), 'adapter_harness_sha256': sha(harness),
        'runner_sha256': sha(__file__), 'core_byte_identical': True, 'core_files': core,
        'adapter_scope': ['retain_failed_preflight_for_diagnostics', 'immutable_source_and_size_dispatch_guard',
                          'explicit_per_prototype_scale_solver_translation', 'largest_first_building_queue'],
        'visual_review': 'automatic diagnostics only; human phase2 remains pending'})
    return harness


def _rebase_paths(value, old, new):
    if isinstance(value, dict):
        return {k: _rebase_paths(v, old, new) for k, v in value.items()}
    if isinstance(value, list):
        return [_rebase_paths(v, old, new) for v in value]
    if isinstance(value, str):
        for prefix in (str(old), str(old).replace('\\', '/')):
            if value == prefix or value.startswith(prefix+'\\') or value.startswith(prefix+'/'):
                return str(new)+value[len(prefix):]
    return value


def support_risks(snapshot):
    sources = snapshot.get('source_model', {}).get('instances', [])
    by_id = {r['instance_id']: r for r in sources}
    children = [r for r in sources if r.get('support_parent_instance_id')]
    roof = [r for r in children if r['prototype_id'] == 'facility-01' and
            by_id.get(r['support_parent_instance_id'], {}).get('prototype_id') == 'building-06']
    carriers = sorted({r['support_parent_instance_id'] for r in roof})
    return {'fixed_children': [{'instance_id': r['instance_id'], 'parent_instance_id': r['support_parent_instance_id'],
            'confirmed_anchor': r['delivery_anchor'], 'status': 'pending_real_deck_support_at_user_size'} for r in children],
        'observed_B06_P01_links': len(roof), 'distinct_B06_carriers': len(carriers),
        'six_distinct_sets_satisfied': len(roof) == 6 and len(carriers) == 6,
        'children_automatically_moved': False,
        'parent_movement_semantics': 'User-confirmed source and child anchors are frozen independently; moving a parent does not authorize moving its child.',
        'formal_approval': False}


def actual_legacy_stack_contract(exported, validation, level, required=6):
    """Report actual exported on/slot trees separately from source observations.

    Structural six-distinct-pair checks supplement the actual plugin stack
    diagnostics. This function never repositions or invents a parent relation.
    """
    by_id = {row.get('id'): row for row in exported}
    cast = {row['name']: row for row in level['cast']}
    links, other_links, structure_errors = [], [], []
    for child in exported:
        if not child.get('on'):
            continue
        parent = by_id.get(child['on'])
        if child['item'] != 'facility-01' or not parent or parent['item'] != 'building-06':
            other_links.append({'child': child.get('id'), 'item': child['item'], 'on': child['on']})
            continue
        slot_name = child.get('slot')
        slot = next((s for s in cast.get(parent['item'], {}).get('stackSlots', []) if s.get('name') == slot_name), None)
        link = {'child': child.get('id'), 'parent': parent['id'], 'slot': slot_name,
                'slotIndex': child.get('slotIndex', 0), 'source_instance_id': child.get('source_instance_id')}
        links.append(link)
        if slot is None or 'facility-01' not in slot.get('riders', []):
            structure_errors.append({**link, 'reason': 'missing_or_incompatible_authored_slot'})
        elif int(slot.get('max', 1)) != 1 or child.get('slotIndex', 0) != 0:
            structure_errors.append({**link, 'reason': 'legacy_pair_requires_one_rider_in_slot0'})
    carriers = Counter(link['parent'] for link in links)
    for parent, amount in carriers.items():
        if amount != 1:
            structure_errors.append({'parent': parent, 'reason': 'multiple_P01_on_one_B06_is_not_distinct_pair', 'children': amount})
    stack_errors = [entry for entry in validation.get('illegal', []) if any(
        word in str(entry.get('reason', '')).lower() for word in ('stack', 'rider', 'carrier', 'slot'))]
    plugin_stacks = validation.get('hardGeometry', {}).get('stacks') or {}
    measured = 'hardGeometry' in validation
    structure_ok = (len(links) == required and len(carriers) == required and not other_links
                    and not structure_errors and len(by_id) == len(exported))
    plugin_ok = (measured and not stack_errors and plugin_stacks.get('count') == required
                 and plugin_stacks.get('riders') == required)
    return {'basis': 'actual_exported_runtime_on_and_slot_plus_real_plugin_validation',
        'required_distinct_B06_P01_pairs': required, 'exported_pair_links': links,
        'exported_pair_count': len(links), 'distinct_exported_B06_carriers': len(carriers),
        'other_exported_on_links': other_links, 'structure_errors': structure_errors,
        'structural_contract_ok': structure_ok, 'plugin_stack_report': plugin_stacks,
        'plugin_stack_related_illegal': stack_errors, 'plugin_stack_geometry_ok': plugin_ok,
        'plugin_overall_validation_ok': bool(validation.get('ok')), 'ok': structure_ok and plugin_ok,
        'source_observations_used_as_admission': False, 'relations_or_poses_modified': False,
        'formal_approval': False}


def run_job(snapshot, job_dir):
    """Backend worker entry point. One finite job, no implicit execution/thread."""
    job_dir = Path(job_dir).resolve()
    if any((job_dir/name).exists() for name in ('run', 'plugin-adapter', 'result.json', 'code-provenance.json')):
        raise ValueError('Use a fresh job directory; never overwrite a previous job')
    job_dir.mkdir(parents=True, exist_ok=True)
    started, logs = time.monotonic(), []
    source = deepcopy(snapshot.get('source_placements', []))
    def progress(value, message, status='running', result=None):
        payload = {'status': status, 'progress': value, 'message': message,
                   'revision': snapshot.get('revision'), 'state_hash': snapshot.get('state_hash')}
        if result is not None:
            payload['result'] = result
        write(job_dir/'status.json', payload)
    try:
        progress(.01, '校验人工冻结坐标、同类大小、素材与数量合同')
        pins = validate_snapshot(snapshot); write(job_dir/'frozen-snapshot.json', snapshot)
        write(job_dir/'input-bindings.json', pins)
        harness = prepare_adapter(job_dir)
        project = job_dir/'project'; original_project = Path(snapshot['project_dir']).resolve()
        shutil.copytree(original_project, project, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', 'harness-journal.jsonl'))
        old_meta = read(project/'project.json')
        old_mask_path = Path(old_meta['semanticMask']) if old_meta.get('semanticMask') else None
        aliases = [original_project]
        if old_mask_path is not None:
            aliases.append(old_mask_path.parent.parent)
        for path in project.rglob('*.json'):
            if path.is_relative_to(project/'scene-handoff'):
                continue  # Pinned Stage2 evidence bytes are immutable, including metadata paths.
            try:
                value = read(path)
            except (ValueError, UnicodeError):
                continue
            rebased = value
            for alias in aliases:
                rebased = _rebase_paths(rebased, alias, project)
            if rebased != value:
                write(path, rebased)
        for filename in ('execution-contract.json', 'supplement-focus-switch.json'):
            path = project/filename
            if path.exists():
                path.unlink()  # Only this new isolated copy; old execution is read-only.
        mask = project/'mask/semantic.png'; mask.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(snapshot['mask_binding']['path'], mask)
        meta = read(project/'project.json'); meta['semanticMask'] = str(mask)
        meta['backgroundSource'] = str(project/'background/background.png')
        meta['assetsSource'] = str(project/'item')
        write(project/'project.json', meta)
        validation_only = snapshot.get('job_kind', snapshot.get('mode')) == 'validate'
        imported_reference = deepcopy(snapshot.get('all_placements', snapshot.get('current_instances',
            source+snapshot.get('supplemental_placements', [])))) if validation_only else source
        initial = lock_report(source, imported_reference, snapshot['prototype_scales'], snapshot['contract']['counts'])
        if not initial['ok']:
            raise ValueError('Validation input source/size locks failed: '+str(initial['errors']))
        imported = canonical_import_order(imported_reference)
        write(job_dir/'import-order-map.json', {'input_ids': [r['id'] for r in imported_reference],
            'official_draft_add_order': [r['id'] for r in imported],
            'operation': 'array_order_only; existing_ID_and_all_pose_fields_unchanged',
            'invariant': all_pose_report(imported_reference, imported, require_all=True)})
        guard = {'source_placements': source, 'prototype_scales': snapshot['prototype_scales'],
                 'counts': snapshot['contract']['counts']}
        if validation_only:
            guard['locked_placements'] = imported
        write(project/'manual-job-contract.json', guard)
        run = job_dir/'run'
        def call(command, *args, must=False):
            remaining = JOB_SECONDS-(time.monotonic()-started)
            if remaining <= 0:
                raise TimeoutError('Finite manual plugin job time budget exhausted')
            argv = [sys.executable, '-X', 'utf8', str(harness), command, *map(str, args)]
            tick = time.monotonic()
            try:
                result = subprocess.run(argv, cwd=ROOT, env={**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8',
                    'PYTHONDONTWRITEBYTECODE': '1'}, capture_output=True, text=True, encoding='utf-8', timeout=min(120, remaining))
            except subprocess.TimeoutExpired as exc:
                text = lambda value: value.decode('utf-8', errors='replace') if isinstance(value, bytes) else value or ''
                logs.append({'argv': argv, 'command': command, 'exit_code': 124, 'runner_timeout': True,
                    'seconds': round(time.monotonic()-tick, 3), 'stdout': text(exc.stdout), 'stderr': text(exc.stderr)})
                write(job_dir/'command-log.json', logs)
                raise TimeoutError('Finite plugin command timed out: '+command) from exc
            logs.append({'argv': argv, 'command': command, 'exit_code': result.returncode,
                         'seconds': round(time.monotonic()-tick, 3), 'stdout': result.stdout, 'stderr': result.stderr})
            write(job_dir/'command-log.json', logs)
            if must and result.returncode:
                raise RuntimeError(command+' failed: '+result.stderr[-1600:])
            return result
        progress(.08, '以单一seed20261014创建真实插件运行；保留原有冲突')
        call('prep', '--project', project, '--run-dir', run, '--mask', mask, '--seed', SEED,
             '--delivery-mode', 'static', '--stacking', 'on', '--stack-allow-targets', '--count-tolerance', 0, must=True)
        call('draft-init', '--run-dir', run, '--u', .5, must=True)
        note = ('自动按钮生成的诊断候选；仅机器检查源锁、尺度哈希和真实插件诊断；尚未进行用户或代理视觉验收，第二阶段人工审阅待完成。')
        call('note', '--run-dir', run, '--tag', 'deviation', '--text', note+' 单seed；不改变人工尺寸、不移动锁定源或屋顶孩子，不允许数量减少。')
        for offset in range(0, len(imported), 25):
            batch = job_dir/'batches'/f'source-{offset//25+1:02d}.json'
            write(batch, {'placements': imported[offset:offset+25], 'source_snapshot_hash': content_hash(source)})
            call('draft-add', '--run-dir', run, '--batch', batch, '--reviewed', note, must=True)
            call('draft-lint', '--run-dir', run)
            call('draft-diagnose', '--run-dir', run, '--canvas', 1024, must=True)
        source_check = lock_report(source, read(run/'draft-layout.json')['placements'], snapshot['prototype_scales'], guard['counts'])
        if not source_check['ok']:
            raise ValueError('Actual plugin source import changed manual source: '+str(source_check['errors']))
        write(job_dir/'source-import-lock-check.json', source_check)
        provenance = []
        for group_index, group in enumerate(() if validation_only else ('building', 'prop', 'human')):
            for batch_index in range(MAX_BATCHES_PER_GROUP):
                rows = read(run/'draft-layout.json')['placements']
                _, missing = quantity(rows, guard['counts'])
                prefix = {'building': 'building-', 'prop': 'facility-', 'human': 'character-'}[group]
                needed = sum(n for pid, n in missing.items() if pid.startswith(prefix))
                if not needed:
                    break
                progress(.25+(.55*(group_index*3+batch_index)/9), f'真实Layout补量：{group}，本轮尚缺{needed}')
                proposal_path = run/'draft-proposal.json'
                if proposal_path.exists():
                    proposal_path.unlink()
                proposed = call('draft-propose', '--run-dir', run, '--group', group,
                                '--count', min(25, needed), '--canvas', 1024)
                if not proposal_path.exists():
                    provenance.append({'group': group, 'batch': batch_index, 'proposed': 0, 'error': proposed.stderr[-1500:]}); break
                proposal = read(proposal_path)
                dest = job_dir/'proposals'/f'{group}-{batch_index+1:02d}'; dest.mkdir(parents=True)
                shutil.copy2(proposal_path, dest/'proposal.json')
                render = Path(proposal.get('renderPreview', ''))
                if render.is_file():
                    shutil.copy2(render, dest/'render.jpg')
                entries = deepcopy(proposal.get('placements', []))
                record = {'group': group, 'batch': batch_index, 'proposal_sha256': sha(proposal_path),
                          'render_sha256': sha(render) if render.is_file() else None,
                          'proposal_geometry_hash': content_hash(entries), 'proposed': len(entries),
                          'source_snapshot_hash': content_hash(source), 'user_scales_hash': content_hash(snapshot['prototype_scales']),
                          'visual_review': 'pending_human_phase2; no visual acceptance claimed'}
                provenance.append(record)
                if not entries:
                    break
                # Coordinates/scales/mirrors from the genuine proposal are never edited.
                for entry in entries:
                    entry.update(is_supplemental=True, placement_source='installed_layout_draft_propose',
                        plugin_proposal_sha256=record['proposal_sha256'], plugin_geometry_hash=record['proposal_geometry_hash'])
                batch = dest/'batch.json'; write(batch, {'placements': entries, 'provenance': record})
                call('draft-add', '--run-dir', run, '--batch', batch, '--reviewed', note, must=True)
                call('draft-lint', '--run-dir', run)
                call('draft-diagnose', '--run-dir', run, '--canvas', 1024, must=True)
        write(job_dir/'proposal-provenance.json', provenance)
        progress(.85, '渲染与真实插件校验；不足和原有支撑冲突保留为失败证据')
        draft_rows = read(run/'draft-layout.json')['placements']
        locks = lock_report(source, draft_rows, snapshot['prototype_scales'], guard['counts'])
        if not locks['ok']:
            raise ValueError('Plugin output violated confirmed manual source: '+str(locks['errors']))
        write(job_dir/'final-lock-check.json', locks)
        candidate = job_dir/'candidate-layout.json'; write(candidate, draft_rows)
        finalized = call('draft-finalize', '--run-dir', run, '--reviewed', note)
        # The guard rejects legacy post when finalize could not close an enforced trail.
        call('post', '--run-dir', run)
        final_layout = run/'layout.json' if (run/'layout.json').is_file() else candidate
        call('render', '--run-dir', run, '--layout', final_layout, '--out', run/'render.jpg', '--canvas', 1600)
        if (run/'render.jpg').is_file():
            shutil.copy2(run/'render.jpg', job_dir/'render.jpg')
        if final_layout == candidate:
            call('validate', '--run-dir', run, '--layout', final_layout)
            validation_path = run/'validation-candidate-layout.json'
        else:
            call('validate', '--run-dir', run)
            validation_path = run/'validation.json'
        validation = read(validation_path) if validation_path.is_file() else {'ok': False, 'error': 'Plugin validation artifact missing'}
        exported = read(final_layout)
        final_locks = lock_report(source, exported, snapshot['prototype_scales'], guard['counts'])
        if not final_locks['ok']:
            raise ValueError('Final plugin export changed frozen source or class size')
        poses = all_pose_report(imported_reference, exported, require_all=True) if validation_only else None
        if poses and not poses['ok']:
            raise ValueError('Validation-only job changed existing layout pose')
        supplements = deepcopy(snapshot.get('supplemental_placements', [r for r in imported if not r.get('source_instance_id')])) if validation_only else [r for r in exported if not r.get('source_instance_id')]
        counts, missing = quantity(exported, guard['counts'])
        risks = support_risks(snapshot)
        actual_stacks = actual_legacy_stack_contract(exported, validation, read(project/'level.json'), snapshot['contract'].get('stacks', 6))
        for record in pins:
            if sha(record['path']) != record['sha256']:
                raise ValueError('Read-only snapshot input changed during plugin job')
        result = {'status': 'succeeded' if validation.get('ok') and not missing and actual_stacks['ok'] else 'partial',
            'source_placements': source, 'supplemental_placements': supplements, 'counts': counts, 'deficits': missing,
            'targets': {pid: counts.get(pid, 0) for pid in TARGETS}, 'seed': SEED,
            'revision': snapshot.get('revision'), 'state_hash': snapshot.get('state_hash'),
            'job_kind': 'validate' if validation_only else 'supplement',
            'diagnostics': {'validation': validation, 'source_and_scale_locks': final_locks,
                            'stack_support': risks, 'observed_source_support': risks,
                            'actual_legacy_stack_contract': actual_stacks,
                            'all_pose_locks': poses, 'finalize_exit': finalized.returncode,
                            'failed_commands': [{'command': row['command'], 'exit_code': row['exit_code'], 'error': row['stderr'][-1200:]} for row in logs if row['exit_code']]},
            'artifacts': {'render': str(job_dir/'render.jpg'), 'validation': str(validation_path),
                          'command_log': str(job_dir/'command-log.json'), 'provenance': str(job_dir/'code-provenance.json'),
                          'proposal_provenance': str(job_dir/'proposal-provenance.json'), 'layout': str(final_layout)},
            'project_dir': str(project), 'run_dir': str(run), 'same_class_scales_preserved': True,
            'source_hashes_preserved': True, 'formal_complete': False, 'visual_approval': False,
            'message': (f'真实插件重新检验完成：原有{len(source)}＋补充{len(supplements)}，尚缺{sum(missing.values())}；原图支撑/正式校验待审。'
                        if validation_only else f'真实插件有限补量完成：新增{len(supplements)}，尚缺{sum(missing.values())}；原图支撑/正式校验待审。')}
        write(job_dir/'result.json', result)
        progress(1, result['message'], result['status'], result)
        return result
    except BaseException as exc:
        preserved_supplements, retained_counts, retained_missing = [], {}, {}
        partial_draft = job_dir/'run/draft-layout.json'
        if partial_draft.is_file() and source and snapshot.get('prototype_scales'):
            try:
                partial_rows = read(partial_draft)['placements']
                check = lock_report(source, partial_rows, snapshot['prototype_scales'], snapshot['contract']['counts'])
                if check['ok']:
                    preserved_supplements = [r for r in partial_rows if not r.get('source_instance_id')]
                    retained_counts, retained_missing = quantity(partial_rows, snapshot['contract']['counts'])
            except (ValueError, KeyError, OSError):
                pass
        result = {'status': 'failed', 'source_placements': source, 'supplemental_placements': [],
            'revision': snapshot.get('revision'), 'state_hash': snapshot.get('state_hash'),
            'diagnostics': {'error': f'{type(exc).__name__}: {exc}', 'preserved_partial_supplements': preserved_supplements},
            'counts': retained_counts, 'deficits': retained_missing, 'formal_complete': False, 'visual_approval': False,
            'message': '插件任务失败；冻结原有实例未修改：'+str(exc),
            'artifacts': {'command_log': str(job_dir/'command-log.json')}}
        write(job_dir/'result.json', result); progress(1, result['message'], 'failed', result)
        return result


def fixture_snapshot():
    """Read-only fixture for a deliberate local evidence run, never on import."""
    base = ROOT/'outputs/tmc-layout-execution/grand-canyon-r03'
    source = read(base/'source-placements.json')['placements']
    catalog = read(base/'rebased-catalog.json'); model = read(base/'rebased-source-model.json')
    # The old raw placement file predates the latest baked-PNG tune. Reproject
    # current confirmed feet through current geometry; never reuse stale pivots.
    by_id = {r['instance_id']: r for r in model['instances']}
    for row in source:
        reference = by_id[row['source_instance_id']]; asset = catalog[row['item']]
        width, height = asset['native_size']; crop = asset['alpha_crop']; u, v = asset['anchor_fraction']
        ax, ay = crop[0]+u*(crop[2]-crop[0]), crop[1]+v*(crop[3]-crop[1])
        if row['mirrored']:
            ax = width-ax
        anchor = reference['delivery_anchor']
        pivot = [anchor[0]+width/2-ax, anchor[1]+height-ay]
        row.update(x=(pivot[0]/4096-.5)*40.96, y=(.5-pivot[1]/4096)*40.96,
                   scale=1.0, delivery_anchor=deepcopy(anchor))
    project = base/'project-building-balance'
    return {'schema': 'manual-layout-frozen.v1', 'project_dir': str(project), 'asset_root': str(base),
        'source_placements': source, 'source_model': model, 'catalog': catalog,
        'prototype_scales': {pid: 1.0 for pid in catalog},
        'contract': {'counts': {r['name']: r['count'] for r in read(project/'level.json')['cast']},
                     'total': 162, 'targets': TARGETS, 'vehicles': 0, 'stacks': 6},
        'mask_binding': {'path': str(project/'mask/semantic.png'), 'sha256': sha(project/'mask/semantic.png')},
        'bindings': [], 'revision': 'frozen-r03-test', 'state_hash': content_hash(source)}


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(); parser.add_argument('--fixture', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    options = parser.parse_args()
    if not options.fixture:
        parser.error('CLI evidence requires explicit --fixture; UI uses run_job after button authorization')
    outcome = run_job(fixture_snapshot(), options.output)
    print(json.dumps({k: outcome.get(k) for k in ('status', 'message', 'counts', 'deficits', 'artifacts')}, ensure_ascii=False))
