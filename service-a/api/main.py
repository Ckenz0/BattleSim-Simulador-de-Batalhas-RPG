"""HTTP entry point. Work is accepted locally and delivered by the SQLite outbox."""
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import Field, StrictInt, model_validator

from battle_contracts.logging import log
from battle_contracts.models import Character, CharacterCreate, Contract
from .database import Database

class BattleInput(Contract):
    character_a_id: UUID
    character_b_id: UUID

    @model_validator(mode="after")
    def distinct(self):
        if self.character_a_id == self.character_b_id:
            raise ValueError("Selecione dois personagens diferentes")
        return self

class BatchInput(BattleInput):
    count: Annotated[StrictInt, Field(ge=1, le=1000)]

def create_app(db_path: str | Path | None = None, broker_enabled=True) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app):
        app.state.db = Database(db_path or os.getenv("DATABASE_PATH", "data/battlesim.db"))
        app.state.bus = None
        if broker_enabled:
            from .messaging import MessageBus
            app.state.bus = MessageBus(app.state.db, os.environ["RABBITMQ_URL"])
            await app.state.bus.start()
        try:
            yield
        finally:
            if app.state.bus:
                await app.state.bus.stop()

    app = FastAPI(title="BattleSim API", version="0.1.0", docs_url="/api/docs",
                  openapi_url="/api/openapi.json", redoc_url=None, lifespan=lifespan)

    @app.middleware("http")
    async def correlation(request: Request, call_next):
        candidate = request.headers.get("x-request-id", "")
        request.state.request_id = candidate if re.fullmatch(r"[A-Za-z0-9._:-]{1,128}",candidate) else uuid4().hex
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        log("http_request",request_id=request.state.request_id,method=request.method,path=request.url.path,
            status=response.status_code)
        return response

    @app.exception_handler(KeyError)
    async def missing(request, exc):
        return JSONResponse(status_code=404,content={"detail": str(exc.args[0])})

    @app.get("/api/health")
    def health(request: Request):
        bus = request.app.state.bus
        connected = bool(bus and bus.connected)
        return {"status":"ok" if connected else "degraded","database":request.app.state.db.ping(),
                "broker_connected":connected}

    @app.get("/api/health/live")
    def live():
        return {"status":"alive"}

    @app.get("/api/health/ready")
    def ready(request: Request):
        state=health(request)
        return JSONResponse(status_code=200 if state["broker_connected"] and state["database"] else 503,content=state)

    @app.post("/api/characters",status_code=201,response_model=Character)
    def create_character(data: CharacterCreate, request: Request):
        return request.app.state.db.create_character(data)

    @app.get("/api/characters")
    def characters(request: Request,limit: int=Query(50,ge=1,le=100),offset: int=Query(0,ge=0)):
        return request.app.state.db.list_characters(limit,offset)

    @app.get("/api/characters/{character_id}",response_model=Character)
    def character(character_id: UUID,request: Request):
        return request.app.state.db.get_character(character_id)

    @app.post("/api/battles/batch",status_code=202)
    def batch(data: BatchInput,request: Request):
        result=request.app.state.db.create_battles(data.character_a_id,data.character_b_id,data.count,request.state.request_id)
        log("batch_accepted",batch_id=result["batch_id"],request_id=request.state.request_id,count=data.count)
        return result

    @app.post("/api/battles",status_code=202)
    def battle(data: BattleInput,request: Request):
        created=request.app.state.db.create_battles(data.character_a_id,data.character_b_id,1,request.state.request_id)
        bid=created["battle_ids"][0]
        log("battle_accepted",battle_id=bid,request_id=request.state.request_id)
        return request.app.state.db.get_battle(bid)

    @app.get("/api/battles")
    def battles(request: Request,limit: int=Query(20,ge=1,le=100),offset: int=Query(0,ge=0),
                status: Literal["pending","processing","completed","failed"]|None=None,batch_id: UUID|None=None):
        return request.app.state.db.list_battles(limit,offset,status,batch_id)

    @app.get("/api/battles/{battle_id}")
    def battle_detail(battle_id: UUID,request: Request):
        return request.app.state.db.get_battle(battle_id)

    @app.get("/api/stats")
    def stats(request: Request):
        return request.app.state.db.stats()

    return app

app = create_app()
