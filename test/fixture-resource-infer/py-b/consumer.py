PY_QUEUE_PATH = "/var/run/infer/py-queue"


def py_b_read():
    with open(PY_QUEUE_PATH) as fh:
        return fh.read()
