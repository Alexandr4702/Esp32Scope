import gzip
import pathlib
import sys


for name in sys.argv[1:]:
    source = pathlib.Path(name)
    source.with_name(source.name + ".gz").write_bytes(
        gzip.compress(source.read_bytes(), compresslevel=9, mtime=0)
    )
