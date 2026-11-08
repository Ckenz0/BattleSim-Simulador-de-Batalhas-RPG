from uuid import UUID
from fastapi import APIRouter, Query, Request
from .adventure_catalog import AdventureCreate, Upgrade, catalog

router = APIRouter(prefix='/api/adventures', tags=['Adventure'])

@router.get('/catalog')
def adventure_catalog():
    return catalog()

@router.post('', status_code=201)
def create(data: AdventureCreate, request: Request):
    return request.app.state.adventures.create(data)

@router.get('')
def list_adventures(request: Request, limit: int=Query(50, ge=1, le=100), offset: int=Query(0, ge=0)):
    return request.app.state.adventures.list(limit, offset)

@router.get('/{adventure_id}')
def detail(adventure_id: UUID, request: Request):
    return request.app.state.adventures.get(adventure_id)

@router.post('/{adventure_id}/battles', status_code=202)
def start(adventure_id: UUID, request: Request):
    return request.app.state.adventures.start(adventure_id, request.state.request_id)

@router.post('/{adventure_id}/upgrades')
def upgrade(adventure_id: UUID, data: Upgrade, request: Request):
    return request.app.state.adventures.upgrade(adventure_id, data)
