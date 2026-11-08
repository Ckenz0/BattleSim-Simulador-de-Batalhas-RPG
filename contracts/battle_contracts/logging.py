"""One JSON log per operation, without connection strings or credentials."""
import json
import logging
from .models import utcnow

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("battlesim")

def log(event: str, **fields):
    logger.info(json.dumps({"timestamp": utcnow().isoformat(), "event": event, **fields}, default=str))
