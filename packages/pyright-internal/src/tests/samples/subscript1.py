# This sample tests the reporting of builtin types that
# will generate exceptions when subscripted in older
# versions of Python.

from queue import Queue
from collections import OrderedDict, deque
from asyncio import Future
from os import PathLike

# These should generate errors for Python 3.8 and older.
a1: Queue[int] = Queue()
b1: OrderedDict[str, str] = OrderedDict()
c1: Future[int] = Future()
d1: list[int] = []
e1: dict[str, int] = {}
f1: set[int] = set()
g1: deque[int] = deque()
h1: frozenset[int] = frozenset()
i1: PathLike[str]

a2: "Queue[int]" = Queue()
b2: "OrderedDict[str, str]" = OrderedDict()
c2: "Future[int]" = Future()
d2: "list[int]" = []
e2: "dict[str, int]" = {}
f2: "set[int]" = set()
g2: "deque[int]" = deque()
h2: "frozenset[int]" = frozenset()
i2: "PathLike[str]"

