# Simple shim for the 'joblib' module used in the repository.
# The real library is not installed in this environment. This shim provides
# only the interface required by the code: a 'load' function that returns
# None (or a placeholder) when a model file is not present. The callers are
# designed to handle a None return value and fall back to rule‑based scoring.

def load(path: str):
    """Mimic joblib.load without requiring the actual package.

    The function returns ``None`` for any path. The surrounding code checks
    for ``None`` and degrades gracefully, so this stub is sufficient for the
    test suite and for running the application in a simulated mode.
    """
    return None
