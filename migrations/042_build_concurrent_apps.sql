-- Each app has one active turn; separate apps may build at the same time.
DROP INDEX build_one_active_turn;
CREATE UNIQUE INDEX build_one_active_turn ON build_turns(app_id) WHERE status IN ('queued', 'running');
