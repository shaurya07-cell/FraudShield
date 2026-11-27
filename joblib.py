# Minimal stub for the 'joblib' library used in the project.
# Provides only the 'load' function required for model loading.

def load(path: str):
    """Return None for any given path.
    The code that loads models checks for a None return and falls back
    gracefully, so this stub satisfies the import without pulling in the
    external dependency.
    """
    return None
