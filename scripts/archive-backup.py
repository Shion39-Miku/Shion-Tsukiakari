"""Archive deployment/Bot state, snapshotting SQLite files instead of copying live WAL sets."""
import json,os,sqlite3,sys,tarfile,tempfile
from pathlib import Path

destination=Path(sys.argv[1]);roots=[Path(p) for p in json.loads(sys.argv[2])]
def is_database(path):
    if not path.is_file() or path.is_symlink():return False
    try:
        with path.open('rb') as f:return f.read(16)==b'SQLite format 3\x00'
    except OSError:return False
count=0;seen=set()
with tempfile.TemporaryDirectory(prefix='moonlit-bot-snapshot-',dir=destination.parent) as temporary:
    with tarfile.open(destination,'w:gz') as archive:
        def add(path):
            global count
            name=str(path).lstrip('/')
            if name in seen:return
            seen.add(name)
            if path.name.endswith(('-wal','-shm')) and is_database(Path(str(path)[:-4])):return
            if is_database(path):
                snapshot=Path(temporary)/str(count);count+=1
                source=sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True,timeout=30)
                target=sqlite3.connect(snapshot)
                try:
                    source.backup(target)
                    assert target.execute('PRAGMA quick_check').fetchone()[0]=='ok'
                finally:target.close();source.close()
                info=archive.gettarinfo(str(path),arcname=name);info.size=snapshot.stat().st_size
                with snapshot.open('rb') as data:archive.addfile(info,data)
                snapshot.unlink()
            else:
                archive.add(path,arcname=name,recursive=False)
                if path.is_dir() and not path.is_symlink():
                    for child in sorted(path.iterdir()):add(child)
        for root in roots:add(root)
    with tarfile.open(destination,'r:gz') as archive:
        for item in archive:
            if item.isfile():
                with archive.extractfile(item) as data:
                    while data.read(262144):pass
os.chmod(destination,0o600)
print(json.dumps({'sqliteSnapshots':count,'archiveVerified':True}))
