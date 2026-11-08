"""Shared transactional battle/outbox insert; caller owns the transaction."""
def insert_battle(db, task, batch_id=None):
    bid, payload, now = str(task.battle_id), task.model_dump_json(), task.created_at.isoformat()
    db.execute('''INSERT INTO battles
        (id,batch_id,status,request_id,task_json,created_at,updated_at)
        VALUES (?,?,'pending',?,?,?,?)''', (bid, batch_id or bid, task.request_id, payload, now, now))
    db.execute('INSERT INTO outbox (battle_id,payload) VALUES (?,?)', (bid, payload))
    return bid
