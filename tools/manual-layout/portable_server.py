"""Repository standalone server. Run from any working directory; loopback only."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote,urlsplit,parse_qs
import argparse, json, secrets, shutil
import backend

ROOT=Path(__file__).resolve().parents[2]
ASSETS=ROOT/'manual-layout'
OUTPUT=ROOT/'outputs/manual-layout'
TOKEN=secrets.token_urlsafe(32)
STORE=None

def initialize():
    global STORE
    root=OUTPUT/'user-workspace'
    if not (root/'state.json').exists():
        seed=json.loads((Path(__file__).parent/'seed-state.json').read_text(encoding='utf8'))
        dest=root/seed['snapshot_relative'];dest.parent.mkdir(parents=True,exist_ok=True)
        shutil.copytree(Path(__file__).parent/'baseline',dest,dirs_exist_ok=True)
        backend._write(root/'state.json',seed)
    STORE=backend.ManualLayoutStore(root)

class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(ROOT),**kwargs)
    def reply(self,status,value):
        raw=json.dumps(value,ensure_ascii=False,allow_nan=False).encode('utf8');self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    def end_headers(self):self.send_header('Cache-Control','no-store');super().end_headers()
    def do_GET(self):
        parsed=urlsplit(self.path)
        if parsed.path.startswith('/api/manual-layout/'):
            try:
                value=backend.dispatch_get(STORE,parsed.path.rsplit('/',1)[-1],{k:v[0]for k,v in parse_qs(parsed.query).items()})
                if parsed.path.endswith('/state'):value={**value,'token':TOKEN}
                self.reply(200,value)
            except (ValueError,KeyError,OSError) as exc:self.reply(400,{'error':str(exc)})
            return
        if parsed.path in ('/','/manual-layout'):
            self.send_response(302);self.send_header('Location','/manual-layout/');self.end_headers();return
        super().do_GET()
    def do_POST(self):
        host=self.headers.get('Host','');allowed={f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}'}
        if host not in allowed or self.headers.get('Origin')!='http://'+host or self.headers.get('X-Stage3-Token')!=TOKEN:
            self.reply(403,{'error':'Use the local page and its request token.'});return
        try:
            if self.headers.get('Content-Type','').split(';')[0]!='application/json':raise ValueError('JSON required')
            size=int(self.headers.get('Content-Length','0'))
            if not 0<size<=1024*1024:raise ValueError('JSON request exceeds size limit')
            body=json.loads(self.rfile.read(size));path=urlsplit(self.path).path
            if not path.startswith('/api/manual-layout/') or not isinstance(body,dict):raise ValueError('Invalid request')
            action=path.rsplit('/',1)[-1];value=backend.dispatch_post(STORE,action,body)
            self.reply(202 if action in ('supplement','validate')else 200,value)
        except (ValueError,TypeError,KeyError,OSError) as exc:self.reply(getattr(exc,'status_code',400),{'error':str(exc)})
    def translate_path(self,path):
        route=unquote(urlsplit(path).path)
        if route.startswith('/manual-layout-output/'):
            dest=(OUTPUT/route.removeprefix('/manual-layout-output/')).resolve()
            return str(dest if dest.is_relative_to(OUTPUT.resolve())else OUTPUT/'invalid')
        if route.startswith('/manual-layout/'):
            name=route.removeprefix('/manual-layout/')or 'local.html'
            # Local HTML omits the GitHub Pages transport. No directory listing.
            dest=(ASSETS/name).resolve()
            return str(dest if dest.is_relative_to(ASSETS.resolve())and dest.is_file()else ASSETS/'invalid')
        return str(ASSETS/'invalid')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8844);args=parser.parse_args()
    initialize();print(f'Manual layout: http://127.0.0.1:{args.port}/manual-layout/',flush=True)
    ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
