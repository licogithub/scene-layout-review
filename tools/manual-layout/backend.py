"""Two-stage manual edits and frozen plugin jobs; never mutate execution inputs."""
from collections import Counter
from copy import deepcopy
from hashlib import sha256
from pathlib import Path
from threading import RLock, Thread
import importlib.util
import io
import json
import math
import shutil
import time
import uuid
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUTPUT_ROOT = ROOT/'outputs/manual-layout'
CATEGORIES = ('building', 'facility', 'character', 'vehicle')
TARGETS = {'facility-01': 9, 'character-01': 3, 'character-02': 9}


class Conflict(ValueError):
    status_code = 409


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _digest(value):
    return sha256(_json(value).encode('utf8')).hexdigest()


def _read(path):
    return json.loads(Path(path).read_text(encoding='utf8'))


def _write(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name+'.tmp-'+uuid.uuid4().hex)
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf8')
    temporary.replace(path)


def _safe(root, relative):
    root = Path(root).resolve(); value = Path(relative)
    if value.is_absolute() or '..' in value.parts:
        raise ValueError('Relative path escapes snapshot')
    result = (root/value).resolve()
    if not result.is_relative_to(root):
        raise ValueError('Path escapes snapshot')
    return result


def _category(pid):
    return pid.split('-', 1)[0]


def _factor(value):
    if isinstance(value, bool): raise ValueError('Size factor must be numeric')
    value = float(value)
    if not math.isfinite(value) or not .1 <= value <= 2:
        raise ValueError('Size factor must be between 0.1 and 2')
    return value


def _reference(asset):
    if asset.get('native_support_point') is not None:
        return asset['native_support_point']
    c=asset['alpha_crop'];u,v=asset['anchor_fraction']
    return [c[0]+u*(c[2]-c[0]),c[1]+v*(c[3]-c[1])]


def _bbox(anchor, asset, scale, mirrored):
    c=asset['alpha_crop'];q=_reference(asset)
    x=anchor[0]-(c[2]-q[0] if mirrored else q[0]-c[0])*scale
    y=anchor[1]-(q[1]-c[1])*scale
    return [x,y,x+(c[2]-c[0])*scale,y+(c[3]-c[1])*scale]


def _runtime_at_anchor(raw, anchor, asset, scale):
    """Native rig to the real renderer's full-PNG bottom-center world pivot."""
    r=deepcopy(raw);w,h=asset['native_size'];q=_reference(asset)
    qx=w-q[0] if r.get('mirrored', False) else q[0]
    px=anchor[0]+scale*(w/2-qx);py=anchor[1]+scale*(h-q[1])
    r.update(x=(px/4096-.5)*40.96,y=(.5-py/4096)*40.96,
             scale=scale,delivery_anchor=list(anchor))
    return r


def _runtime_anchor(raw, asset):
    w,h=asset['native_size'];q=_reference(asset);s=float(raw.get('scale',1))
    qx=w-q[0] if raw.get('mirrored',False) else q[0]
    px=(float(raw['x'])/40.96+.5)*4096;py=(.5-float(raw['y'])/40.96)*4096
    return [px-s*(w/2-qx),py-s*(h-q[1])]


def snapshot_execution(destination, source=None):
    """Capture only a stable complete input set, checking all bytes twice."""
    source=Path(source or ROOT/'outputs/tmc-layout-execution/grand-canyon-r03').resolve()
    if not source.is_relative_to(ROOT): raise ValueError('Execution source outside workspace')
    project=source/('project-building-balance' if (source/'project-building-balance').is_dir() else 'project')
    required=['source-placements.json','rebased-catalog.json','rebased-source-model.json','scale-policy.json','execution-contract.json']
    paths=[source/n for n in required]
    paths += [source/'source-snapshot/standard'/n for n in
              ['source-observation-ledger.json','original.png','clean.png','prototype-size-policy.json']]
    paths += [p for p in (source/'scaled-handoff').rglob('*') if p.is_file()]
    excluded={'harness-journal.jsonl','supplement-focus-switch.json'}
    paths += [p for p in project.rglob('*') if p.is_file() and p.name not in excluded]
    paths=sorted(set(paths))
    if any(not p.resolve().is_relative_to(source)for p in paths):raise ValueError('Snapshot source symlink escapes execution directory')
    if any(not p.is_file() for p in paths) or not (project/'level.json').is_file():
        raise ValueError('Incomplete execution input set; snapshot refused')
    first={str(p.relative_to(source)).replace('\\','/'):p.read_bytes() for p in paths}
    catalog=json.loads(first['rebased-catalog.json']);placements=json.loads(first['source-placements.json'])['placements']
    contract=json.loads(first['execution-contract.json']);level=json.loads(first[str((project/'level.json').relative_to(source)).replace('\\','/')])
    expected=contract['expected_counts']
    if len(catalog)!=24 or len(placements)!=81 or sum(expected.values())!=162 or contract['targets']!=TARGETS:
        raise ValueError('Source contract is not 24/81/162/21')
    cast={x['name']:x for x in level['cast']}
    if set(cast)!=set(catalog) or any(cast[k]['count']!=expected[k] for k in catalog):
        raise ValueError('Project cast/counts disagree with catalog contract')
    if any(_category(k)=='vehicle' for k in catalog): raise ValueError('This map contract has zero vehicles')
    ledger=json.loads(first['source-snapshot/standard/source-observation-ledger.json'])
    if len(ledger['instances'])!=209:raise ValueError('Full 209-observation ledger is missing')
    ids=[r['source_instance_id'] for r in placements]
    if len(set(ids))!=81 or any(r['item'] not in catalog for r in placements):
        raise ValueError('Source identity set is invalid')
    for pid,asset in catalog.items():
        native=_safe(source,asset['src'])
        rel=str(native.relative_to(source)).replace('\\','/')
        item=str((project/'item'/cast[pid]['file']).relative_to(source)).replace('\\','/')
        if rel not in first or sha256(first[rel]).hexdigest()!=asset['sha256'] or first[rel]!=first[item]:
            raise ValueError('Rebased PNG and project item disagree: '+pid)
        with Image.open(io.BytesIO(first[rel]))as image:
            measured=image.convert('RGBA').getchannel('A').point(lambda v:255 if v>16 else 0).getbbox()
            if list(image.size)!=asset['native_size']or list(measured or [])!=asset['alpha_crop']:
                raise ValueError('Rebased PNG dimensions/alpha crop disagree: '+pid)
    if any(p.read_bytes()!=first[str(p.relative_to(source)).replace('\\','/')] for p in paths):
        raise Conflict('Execution inputs changed during snapshot; retry after their write completes')
    pins={name:sha256(data).hexdigest() for name,data in first.items()}
    content_hash=_digest(pins);dest=Path(destination)/('baseline-'+content_hash[:20])
    dest.mkdir(parents=True,exist_ok=True)
    for name,data in first.items():
        target=_safe(dest,name);target.parent.mkdir(parents=True,exist_ok=True)
        if target.exists() and target.read_bytes()!=data: raise Conflict('Snapshot content-address collision')
        if not target.exists():target.write_bytes(data)
    metadata={'schema':'manual-layout-baseline.v1','source_dir':str(source),'content_hash':content_hash,
              'files':pins,'project_relative':str(project.relative_to(source)).replace('\\','/'),
              'captured_at':time.time(),'source_is_read_only':True}
    _write(dest/'snapshot-manifest.json',metadata)
    return dest


class ManualLayoutStore:
    """Single-server store; revision CAS and idempotency guard every mutation."""
    def __init__(self, root_dir=OUTPUT_ROOT, snapshot_dir=None, runner=None):
        self.root=Path(root_dir).resolve()
        if not self.root.is_relative_to(OUTPUT_ROOT.resolve()):
            raise ValueError('Store must stay inside outputs/manual-layout')
        self.root.mkdir(parents=True,exist_ok=True);self._lock=RLock();self.runner=runner;self._threads={}
        self.path=self.root/'state.json'
        if self.path.is_file():
            self.data=_read(self.path);self.snapshot=_safe(self.root,self.data['snapshot_relative'])
            for job in self.data['jobs'].values():
                if job['status']=='running':job.update(status='failed',error='Server restarted; previous worker interrupted, no automatic restart')
        else:
            self.snapshot=snapshot_execution(self.root/'snapshots',snapshot_dir)
            self.data={'revision':0,'phase':'base','snapshot_relative':str(self.snapshot.relative_to(self.root)).replace('\\','/'),
                'source_instance_anchors':{},'category_factors':{c:1. for c in CATEGORIES},
                'prototype_factors':{},'manual_edits':[],'frozen_id':None,'jobs':{},'current_job':None,
                'applied_job':None,'supplemental_placements':[],'supplemental_geometry_hash':None,
                'validation':None,'actions':{},'history':[]}
        self.manifest=_read(self.snapshot/'snapshot-manifest.json');self.catalog=_read(self.snapshot/'rebased-catalog.json')
        self.model=_read(self.snapshot/'rebased-source-model.json');self.raw=_read(self.snapshot/'source-placements.json')['placements']
        self.contract=_read(self.snapshot/'execution-contract.json');self.scale_policy=_read(self.snapshot/'scale-policy.json')
        self.original_policy=_read(self.snapshot/'source-snapshot/standard/prototype-size-policy.json')
        self.baseline={r['instance_id']:r for r in self.model['instances']}
        self.raw_by={r['source_instance_id']:r for r in self.raw}
        if len(self.baseline)!=81 or set(self.baseline)!=set(self.raw_by):raise ValueError('81 source model identity mismatch')
        self.verify_snapshot()
        if not self.data['source_instance_anchors']:
            self.data['source_instance_anchors']={iid:list(r['delivery_anchor'])for iid,r in self.baseline.items()}
        for pid in self.catalog:self.data['prototype_factors'].setdefault(pid,1.)
        self._persist()

    def verify_snapshot(self):
        if _digest(self.manifest['files'])!=self.manifest['content_hash']:raise Conflict('Snapshot manifest pins changed')
        for name,pin in self.manifest['files'].items():
            if sha256(_safe(self.snapshot,name).read_bytes()).hexdigest()!=pin:raise Conflict('Frozen baseline bytes changed: '+name)
        return True

    def _persist(self):_write(self.path,self.data)

    def _geometry_hash(self):
        return _digest({k:self.data[k]for k in ['source_instance_anchors','category_factors','prototype_factors']})

    def _state_hash(self):return _digest({'baseline':self.manifest['content_hash'],'revision':self.data['revision'],
        'geometry':self._geometry_hash(),'layout_pose':self._layout_pose_hash(),'phase':self.data['phase']})

    def _current_runtime(self):
        rows=self._base_rows();by_id={r['instance_id']:r for r in rows}
        # Official draft-add allocates sequential runtime IDs in insertion order.
        # Keep the pinned raw order, independently of visual/model draw order.
        raw=[_runtime_at_anchor(original,by_id[original['source_instance_id']]['delivery_anchor'],
             self.catalog[original['item']],self._scale(original['item']))for original in self.raw]
        supplemental=[_runtime_at_anchor(p,p.get('delivery_anchor')or _runtime_anchor(p,self.catalog[p['item']]),
                          self.catalog[p['item']],self._scale(p['item']))for p in self.data['supplemental_placements']]
        return rows,raw,supplemental

    def _layout_pose_hash(self):
        """Bind every runtime field, including ID, rig/world pose and stack links."""
        _,source,supplemental=self._current_runtime()
        return _digest(source+supplemental)

    def _scale(self,pid):
        return self.data['category_factors'][_category(pid)]*self.data['prototype_factors'][pid]

    def _start_action(self,operation,revision,action_id,payload):
        if not isinstance(action_id,str)or not 1<=len(action_id)<=128:raise ValueError('action_id is required')
        fingerprint=_digest({'operation':operation,'payload':payload})
        cached=self.data['actions'].get(action_id)
        if cached:
            if cached['fingerprint']!=fingerprint:raise Conflict('action_id reused with different data')
            return True
        if isinstance(revision,bool)or revision!=self.data['revision']:raise Conflict('Stale revision; reload state')
        self.verify_snapshot();return False

    def _finish_action(self,operation,action_id,payload):
        self.data['revision']+=1
        self.data['actions'][action_id]={'fingerprint':_digest({'operation':operation,'payload':payload}),'revision':self.data['revision']}
        self.data['history'].append({'operation':operation,'revision':self.data['revision'],'time':time.time()})
        self._persist();return self.state()

    def _url(self,path):
        relative=Path(path).resolve().relative_to(OUTPUT_ROOT.resolve()).as_posix()
        return '/manual-layout-output/'+relative

    def _base_rows(self):
        result=[]
        for iid,old in self.baseline.items():
            row=deepcopy(old);pid=row['prototype_id'];a=self.data['source_instance_anchors'][iid];s=self._scale(pid)
            row['original_measured_source_anchor']=deepcopy(old['source_anchor'])
            row['original_delivery_anchor']=deepcopy(old['delivery_anchor']);row['delivery_anchor']=list(a)
            row['manual_source_anchor']=[v*1254/4096 for v in a]
            row['manual_delta_delivery']=[a[n]-old['delivery_anchor'][n]for n in range(2)]
            row['anchor_locked']=self.data['phase']=='supplement';row['render_bbox']=_bbox(a,self.catalog[pid],s,row['mirror_x'])
            row['scale_measurement']={**row.get('scale_measurement',{}),'uniform_native_to_delivery_scale':s,
                'uniform_native_to_source_scale':s*1254/4096,'native_support_point_used':_reference(self.catalog[pid]),
                'source_render_bbox':[v*1254/4096 for v in row['render_bbox']]}
            result.append(row)
        return result

    def _supplement_rows(self):
        result=[]
        for raw in self.data['supplemental_placements']:
            pid=raw.get('prototype_id',raw['item']);asset=self.catalog[pid]
            a=raw.get('delivery_anchor')or _runtime_anchor(raw,asset);s=self._scale(pid)
            result.append({'instance_id':raw.get('id'),'prototype_id':pid,'category':_category(pid),
                'source_anchor':None,'delivery_anchor':a,'mirror_x':bool(raw.get('mirrored',False)),
                'render_bbox':_bbox(a,asset,s,bool(raw.get('mirrored',False))),
                'placement_source':'supplemental_plugin','is_supplemental':True,'on':raw.get('on'),
                'runtime_id':raw.get('id'),'anchor_locked':True})
        return result

    def _policy(self):
        sizes={}
        for pid,a in self.catalog.items():
            c=a['alpha_crop'];original=self.original_policy['sizes'][pid];body=deepcopy(original.get('body_reference'))
            if body:
                affine=a.get('calibration_rebase',{}).get('transform',{}).get('slope_xy',[1,1])
                body['native_height']=body['native_height']*affine[1];body['delivery_height']=body['native_height']
            sizes[pid]={'width':c[2]-c[0],'height':c[3]-c[1],'native_to_delivery_scale':1.,
                'alpha_crop_native':c,'anchor_fraction':a['anchor_fraction'],'scale_percent':100,
                'body_reference':body,'body_height_delivery':body['delivery_height']if body else None,
                'asset_sha256':a['sha256']}
        return {'mode':'uniform_by_prototype','coordinate_space':'delivery','scope':'all_instances',
                'revision':'manual-baked-baseline-'+self.manifest['content_hash'][:12],'sizes':sizes}

    def state(self):
        with self._lock:
            base_rows=self._base_rows();supplement=self._supplement_rows();existing=Counter(r['prototype_id']for r in base_rows)
            extras=Counter(r['prototype_id']for r in supplement);policy=self._policy();catalog=deepcopy(self.catalog)
            for a in catalog.values():a['src']=self._url(_safe(self.snapshot,a['src']))
            model={**deepcopy(self.model),'instances':base_rows,'prototype_size_policy':policy}
            counts=[{'prototype_id':pid,'category':_category(pid),'existing':existing[pid],
                'supplemental':extras[pid],'target':n,'deficit':max(0,n-existing[pid]-extras[pid])}
                for pid,n in self.contract['expected_counts'].items()]
            counts.append({'prototype_id':'vehicle-disabled','category':'vehicle','existing':0,'supplemental':0,'target':0,'deficit':0,'disabled':True})
            stale=bool(self.data['supplemental_placements'])and self.data['supplemental_geometry_hash']!=self._geometry_hash()
            job=self.job_status(self.data['current_job'])if self.data['current_job']else None
            return {'schema':'manual-layout-state.v1','phase':self.data['phase'],'revision':self.data['revision'],
                'state_hash':self._state_hash(),'layout_pose_hash':self._layout_pose_hash(),'canvas':[4096,4096],'source_size':[1254,1254],
                'source_image':self._url(self.snapshot/'source-snapshot/standard/original.png'),
                'clean_image':self._url(self.snapshot/'scaled-handoff/background.png'),
                'catalog':catalog,'base_model':model,'active_model':{**deepcopy(model),'instances':base_rows+supplement},
                'counts':counts,'plan':{k:deepcopy(self.data[k])for k in ['revision','phase','source_instance_anchors','category_factors','prototype_factors','manual_edits']},
                'prototype_size_policy':policy,'job':job,'validation':deepcopy(self.data['validation']),
                'supplemental_stale':stale,'requires_refreeze':self.data['frozen_id']is None,
                'baseline_label':'100% 是最新人工中档基准；PNG已烘焙一次尺寸，不再重复乘旧百分比',
                'absolute_origin_factors':deepcopy(self.scale_policy.get('multipliers',{})),
                'baseline_reason':self.scale_policy.get('reason'),'observation_ledger_count':209,
                'source_contract':{'prototypes':24,'total':162,'target_total':21,'vehicles':0,'stacks':6},
                'history':deepcopy(self.data['history']),'source_support_warning':'人工移动父建筑默认不带动屋顶设施；支撑需复核。'}

    def save(self,expected_revision,moves=None,category_factors=None,prototype_factors=None,action_id=None):
        payload={'moves':moves or {},'category_factors':category_factors or {},'prototype_factors':prototype_factors or {}}
        with self._lock:
            if self._start_action('save',expected_revision,action_id,payload):return self.state()
            proposed=deepcopy(self.data)
            if payload['moves']and self.data['phase']!='base':raise ValueError('Confirmed source anchors are locked in supplement phase')
            for iid,a in payload['moves'].items():
                if iid not in self.baseline or self.baseline[iid]['category']!='building':raise ValueError('Only existing buildings can be moved manually')
                if not isinstance(a,(list,tuple))or len(a)!=2 or any(isinstance(v,bool)or not isinstance(v,(int,float))or not math.isfinite(v)or not 0<=v<=4096 for v in a):raise ValueError('Building anchor must be inside the delivery canvas')
                before=proposed['source_instance_anchors'][iid];proposed['source_instance_anchors'][iid]=list(a)
                proposed['manual_edits'].append({'instance_id':iid,'original_measured_source_anchor':self.baseline[iid]['source_anchor'],
                    'before_delivery_anchor':before,'after_delivery_anchor':list(a),'delta_delivery':[a[i]-before[i]for i in range(2)],
                    'actor':'human_ui','action_id':action_id,'dependent_facilities_moved':False,
                    'support_dependents':self.baseline[iid].get('source_support_dependents',[])})
            for category,value in payload['category_factors'].items():
                if category not in CATEGORIES:raise ValueError('Unknown category')
                if category=='vehicle':raise ValueError('Vehicles disabled by zero-count contract')
                proposed['category_factors'][category]=_factor(value)
            for pid,value in payload['prototype_factors'].items():
                if pid not in self.catalog:raise ValueError('Unknown prototype')
                proposed['prototype_factors'][pid]=_factor(value)
            old_geometry=self._geometry_hash();self.data=proposed
            if self._geometry_hash()!=old_geometry:self.data['frozen_id']=None;self.data['validation']=None
            return self._finish_action('save',action_id,payload)

    def freeze(self,expected_revision,action_id=None):
        with self._lock:
            if self._start_action('freeze',expected_revision,action_id,{}):return self.state()
            self.data['phase']='supplement';fid='freeze-'+str(self.data['revision']+1)+'-'+self._geometry_hash()[:16]
            self.data['frozen_id']=fid;value=self._job_snapshot();_write(self.root/'freezes'/fid/'snapshot.json',value)
            return self._finish_action('freeze',action_id,{})

    def reopen(self,expected_revision,action_id=None):
        with self._lock:
            if self._start_action('reopen',expected_revision,action_id,{}):return self.state()
            self.data['phase']='base';self.data['frozen_id']=None;self.data['validation']=None
            return self._finish_action('reopen',action_id,{})

    def _job_snapshot(self):
        rows,raw,supplemental=self._current_runtime()
        project=self.snapshot/self.manifest['project_relative'];mask=project/'mask/semantic.png'
        return {'schema':'manual-layout-frozen.v1','snapshot_dir':str(self.snapshot),'asset_root':str(self.snapshot),
            'project_dir':str(project),'source_placements':raw,'source_model':{**deepcopy(self.model),'instances':rows},
            'supplemental_placements':supplemental,'all_placements':raw+supplemental,
            'catalog':deepcopy(self.catalog),'prototype_scales':{pid:self._scale(pid)for pid in self.catalog},
            'contract':{'counts':deepcopy(self.contract['expected_counts']),'total':162,'targets':TARGETS,'target_total':21,'vehicles':0,'stacks':6},
            'mask_binding':{'path':str(mask),'sha256':sha256(mask.read_bytes()).hexdigest()},
            'bindings':[{'path':str(_safe(self.snapshot,name)),'sha256':pin}for name,pin in self.manifest['files'].items()],
            'plan':{k:deepcopy(self.data[k])for k in ['revision','phase','source_instance_anchors','category_factors','prototype_factors']},
            'revision':self.data['revision'],'state_hash':self._state_hash(),'geometry_hash':self._geometry_hash(),
            'layout_pose_hash':_digest(raw+supplemental),
            'baseline_hash':self.manifest['content_hash'],'frozen_id':self.data['frozen_id']}

    def start_job(self,expected_revision,action_id=None,runner_callable=None,*,job_kind='supplement'):
        if job_kind not in ('supplement','validate'):raise ValueError('Unknown plugin job kind')
        operation='start'if job_kind=='supplement'else'validate'
        with self._lock:
            if self._start_action(operation,expected_revision,action_id,{}):return self.state()
            if self.data['phase']!='supplement'or(job_kind=='supplement'and not self.data['frozen_id']):raise ValueError('Confirm/freeze the source layout before supplementing')
            if any(j['status']=='running'for j in self.data['jobs'].values()):raise Conflict('A supplement job is already running')
            jid='job-'+uuid.uuid4().hex;directory=self.root/'jobs'/jid;directory.mkdir(parents=True)
            snap=self._job_snapshot();snap['job_kind']=job_kind;_write(directory/'snapshot.json',snap)
            self.data['jobs'][jid]={'job_id':jid,'kind':job_kind,'status':'running','geometry_hash':snap['geometry_hash'],
                'layout_pose_hash':snap['layout_pose_hash'],
                'frozen_id':snap['frozen_id'],'created_at':time.time(),
                'snapshot_sha256':sha256((directory/'snapshot.json').read_bytes()).hexdigest()}
            self.data['current_job']=jid
            response=self._finish_action(operation,action_id,{})
            thread=Thread(target=self._run_job,args=(jid,snap,directory,runner_callable),daemon=True)
            self._threads[jid]=thread;thread.start();return response

    def _run_job(self,jid,snapshot,directory,runner):
        try:
            if runner is None:runner=self.runner
            if runner is None:
                path=Path(__file__).with_name('plugin_job.py');spec=importlib.util.spec_from_file_location('manual_plugin_job',path)
                module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);runner=module.run_job
            result=runner(deepcopy(snapshot),directory)
            self._check_job_result(snapshot,result)
            self.verify_snapshot()
            _write(directory/'result.json',result)
            with self._lock:
                self.data['jobs'][jid].update(status=result['status'],finished_at=time.time(),result_file='result.json',
                    result_sha256=sha256((directory/'result.json').read_bytes()).hexdigest())
                self._persist()
        except Exception as exc:
            counts=Counter(p['item']for p in snapshot['source_placements'])
            value={'status':'failed','error':str(exc),'deficits':{p:max(0,n-counts[p])for p,n in self.contract['expected_counts'].items()},'source_anchors_changed':False}
            _write(directory/'backend-failure.json',value)
            with self._lock:self.data['jobs'][jid].update(status='failed',error=str(exc),finished_at=time.time());self._persist()

    def _check_job_result(self,snapshot,result):
        if not isinstance(result,dict)or result.get('status')not in ('succeeded','partial','failed'):raise ValueError('Plugin returned invalid terminal status')
        if result['status']=='failed':return
        sources=result.get('source_placements',snapshot['source_placements'])
        if sources!=snapshot['source_placements']:raise ValueError('Plugin changed confirmed source placements')
        if snapshot.get('job_kind')=='validate'and result.get('supplemental_placements',[])!=snapshot['supplemental_placements']:
            raise ValueError('Validation job changed locked supplemental placements')
        source_ids={r['id']for r in sources};seen=set();counts=Counter(r['item']for r in sources)
        for raw in result.get('supplemental_placements',[]):
            pid=raw.get('item');rid=raw.get('id')
            if pid not in self.catalog or raw.get('prototype_id',pid)!=pid:raise ValueError('Plugin returned unknown/changed prototype')
            if not rid or rid in source_ids or rid in seen:raise ValueError('Plugin returned duplicate/missing identity')
            if raw.get('source_instance_id'):raise ValueError('Supplement cannot impersonate source')
            if not math.isclose(float(raw.get('scale',1)),snapshot['prototype_scales'][pid],abs_tol=1e-10):raise ValueError('Plugin changed shared prototype size')
            if not all(math.isfinite(float(raw.get(k,float('nan'))))for k in ('x','y')):raise ValueError('Invalid plugin coordinates')
            if not isinstance(raw.get('mirrored',False),bool):raise ValueError('Invalid plugin mirror')
            counts[pid]+=1;seen.add(rid)
        if any(counts[pid]>n for pid,n in self.contract['expected_counts'].items()):raise ValueError('Plugin exceeded prototype count contract')

    def job_status(self,job_id=None):
        with self._lock:
            jid=job_id or self.data['current_job']
            if jid is None:return None
            if jid not in self.data['jobs']:raise ValueError('Unknown job ID')
            value=deepcopy(self.data['jobs'][jid]);directory=_safe(self.root,'jobs/'+jid)
            value['applied']=bool(value.get('applied_at'))
            progress=directory/'status.json'
            if progress.is_file():
                try:value['progress_detail']=_read(progress)
                except (ValueError,OSError):value['progress_detail']={'message':'progress file update in flight'}
            if value.get('result_file'):
                if sha256((directory/'result.json').read_bytes()).hexdigest()!=value['result_sha256']:raise Conflict('Job result bytes changed')
                value['result']=_read(directory/'result.json')
            value['stale']=value['geometry_hash']!=self._geometry_hash()or value['frozen_id']!=self.data['frozen_id']
            if value.get('kind')=='validate':
                expected=value.get('layout_pose_hash')
                if expected is None:
                    # Older completed jobs remain bound to their original bytes;
                    # no new snapshot/hash is fabricated from the current layout.
                    path=directory/'snapshot.json'
                    if sha256(path.read_bytes()).hexdigest()!=value['snapshot_sha256']:raise Conflict('Job snapshot bytes changed')
                    expected=_digest(_read(path)['all_placements'])
                value['layout_pose_hash']=expected
                value['stale']=value['stale']or expected!=self._layout_pose_hash()
            return value

    def apply_job(self,job_id,expected_revision,action_id=None):
        payload={'job_id':job_id}
        with self._lock:
            if self._start_action('apply-job',expected_revision,action_id,payload):return self.state()
            job=self.job_status(job_id)
            if self.data['phase']!='supplement'or job['stale']:raise Conflict('Job belongs to an obsolete frozen layout')
            if job['status']not in ('succeeded','partial'):raise ValueError('No completed plugin result to apply')
            snapshot_file=self.root/'jobs'/job_id/'snapshot.json'
            if sha256(snapshot_file.read_bytes()).hexdigest()!=job['snapshot_sha256']:raise Conflict('Job snapshot bytes changed')
            snap=_read(snapshot_file);result=job['result'];self._check_job_result(snap,result)
            if job['kind']=='validate':
                expected=_digest(snap['all_placements'])
                if expected!=job['layout_pose_hash']or expected!=self._layout_pose_hash():
                    raise Conflict('Validation result belongs to another complete layout pose')
            if job['kind']=='validate':
                self.data['validation']={'schema':'manual-layout-plugin-validation.v1','job_id':job_id,
                    'geometry_hash':self._geometry_hash(),'status':job['status'],
                    'layout_pose_hash':self._layout_pose_hash(),
                    'diagnostics':deepcopy(result.get('diagnostics',{})),
                    'artifacts':deepcopy(result.get('artifacts',{})),
                    'plugin_executed':True,'visual_approval':False}
                # Current poses were actually checked, even if geometry failed.
                # This is freshness, never an acceptance/pass flag.
                self.data['supplemental_geometry_hash']=self._geometry_hash()
            else:
                self.data['supplemental_placements']=deepcopy(result.get('supplemental_placements',[]))
                self.data['supplemental_geometry_hash']=self._geometry_hash();self.data['applied_job']=job_id;self.data['validation']=None
            self.data['jobs'][job_id]['applied_at']=time.time()
            return self._finish_action('apply-job',action_id,payload)

    def verify_numeric(self,expected_revision=None):
        with self._lock:
            if expected_revision is not None and expected_revision!=self.data['revision']:raise Conflict('Stale revision')
            self.verify_snapshot();rows=self._base_rows()+self._supplement_rows();counts=Counter(r['prototype_id']for r in rows)
            deficits={pid:max(0,n-counts[pid])for pid,n in self.contract['expected_counts'].items()}
            edge=[r['instance_id']for r in rows if min(r['render_bbox'][:2])<0 or max(r['render_bbox'][2:])>4096]
            result={'schema':'manual-layout-validation.v1','revision':self.data['revision'],'state_hash':self._state_hash(),
                'total':len(rows),'required_total':162,'deficits':deficits,'target_total':sum(counts[p]for p in TARGETS),
                'required_target_total':21,'canvas_projection_ids':edge,'source_identity_count':81,
                'required_stacks':6,'actual_stacks':len({p['on']for p in self.raw+self.data['supplemental_placements']if p.get('on')}),
                'source_manual_moves':len({r['instance_id']for r in self.data['manual_edits']}),
                'source_support_pending':True,'terrain_support_pending':True,
                'supplemental_stale':bool(self.data['supplemental_placements'])and self.data['supplemental_geometry_hash']!=self._geometry_hash(),
                'structural_counts_complete':len(rows)==162 and not any(deficits.values()),
                'formal_passed':False,'visual_approval':False,
                'limits':'Structural/hash/count diagnostics only; plugin geometry and human visual review remain separate.'}
            self.data['validation']=result;self._persist();return deepcopy(result)

    def validate(self,expected_revision,action_id=None):
        """Launch a real plugin render/validation job; never substitute local QA."""
        return self.start_job(expected_revision,action_id,job_kind='validate')


def dispatch_get(store,action,query=None):
    query=query or {}
    if action=='state':return store.state()
    if action in ('status','job-status'):return store.job_status(query.get('job_id'))
    raise ValueError('Unknown GET action')


def dispatch_post(store,action,payload):
    if not isinstance(payload,dict):raise ValueError('JSON object required')
    revision=payload.get('revision');aid=payload.get('action_id')
    allowed={'revision','action_id','state_hash'}
    if action=='save':allowed|={'moves','category_factors','prototype_factors'}
    if action in ('apply-job','apply'):allowed|={'job_id'}
    if set(payload)-allowed:raise ValueError('Unsupported client fields: '+','.join(sorted(set(payload)-allowed)))
    if payload.get('state_hash')and payload['state_hash']!=store.state()['state_hash']:
        if aid not in store.data['actions']:raise Conflict('Stale state hash')
    if action=='save':return store.save(revision,payload.get('moves'),payload.get('category_factors'),payload.get('prototype_factors'),aid)
    if action=='freeze':return store.freeze(revision,aid)
    if action=='reopen':return store.reopen(revision,aid)
    if action in ('supplement','start'):return store.start_job(revision,aid)
    if action in ('apply-job','apply'):return store.apply_job(payload.get('job_id'),revision,aid)
    if action=='validate':return store.validate(revision,aid)
    raise ValueError('Unknown POST action')
