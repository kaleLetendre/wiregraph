# Vendored copy in a language that emits NO import candidates at all (Python), so
# mechanism 1 cannot fire even in principle. Reference discovery is token-based and
# therefore language-agnostic, which is exactly why it is reused rather than reimplemented
# per language.
PY_QUEUE_PATH = "/var/run/infer/py-queue"


def py_a_write(payload):
    with open(PY_QUEUE_PATH, "w") as fh:
        fh.write(payload)
