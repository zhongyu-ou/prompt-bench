package workbench

import (
	"database/sql"
	"encoding/json"
	"errors"
)

func insertEvaluation(tx *sql.Tx, d EvaluationDetail) error {
	summary, err := json.Marshal(d.Evaluation)
	if err != nil {
		return err
	}
	snapshot, err := json.Marshal(d.Snapshot)
	if err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO evaluations(id,generation_run_id,created_at,summary,snapshot) VALUES($1,$2,$3,$4,$5)", d.Evaluation.ID, d.Evaluation.GenerationRunID, d.Evaluation.CreatedAt, summary, snapshot); err != nil {
		return err
	}
	return insertEvaluationOutcomes(tx, d)
}
func insertEvaluationOutcomes(tx *sql.Tx, d EvaluationDetail) error {
	for i, o := range d.Outcomes {
		raw, err := json.Marshal(o)
		if err != nil {
			return err
		}
		if _, err = tx.Exec("INSERT INTO evaluation_outcomes(evaluation_id,seq,result_id,metric_id,round,data) VALUES($1,$2,$3,$4,$5,$6)", d.Evaluation.ID, i, o.ResultID, o.MetricID, o.Round, raw); err != nil {
			return err
		}
	}
	return nil
}
func (s *Store) createEvaluation(d EvaluationDetail) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = insertEvaluation(tx, d); err != nil {
		return err
	}
	return tx.Commit()
}

// Activation freezes source outputs once; subsequent updates touch only summary
// and changed judgments, never a snapshot or a generation's legacy evidence.
func (s *Store) updateEvaluation(d EvaluationDetail, activate bool, changed ...EvaluationOutcome) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	summary, err := json.Marshal(d.Evaluation)
	if err != nil {
		return err
	}
	if _, err = tx.Exec("UPDATE evaluations SET summary=$1 WHERE id=$2", summary, d.Evaluation.ID); err != nil {
		return err
	}
	if activate {
		snapshot, err := json.Marshal(d.Snapshot)
		if err != nil {
			return err
		}
		if _, err = tx.Exec("UPDATE evaluations SET snapshot=$1 WHERE id=$2", snapshot, d.Evaluation.ID); err != nil {
			return err
		}
		if err = insertEvaluationOutcomes(tx, d); err != nil {
			return err
		}
	} else {
		for _, o := range changed {
			raw, err := json.Marshal(o)
			if err != nil {
				return err
			}
			if _, err = tx.Exec("UPDATE evaluation_outcomes SET data=$1 WHERE evaluation_id=$2 AND result_id=$3 AND metric_id=$4 AND round=$5", raw, d.Evaluation.ID, o.ResultID, o.MetricID, o.Round); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}
func (s *Store) evaluationDetail(id string) (EvaluationDetail, error) {
	d := EvaluationDetail{Outcomes: []EvaluationOutcome{}}
	var summary, snapshot []byte
	err := s.db.QueryRow("SELECT summary,snapshot FROM evaluations WHERE id=$1", id).Scan(&summary, &snapshot)
	if errors.Is(err, sql.ErrNoRows) {
		return d, errNotFound
	}
	if err != nil {
		return d, err
	}
	if err = decodeStored(summary, &d.Evaluation); err != nil {
		return d, err
	}
	if err = decodeStored(snapshot, &d.Snapshot); err != nil {
		return d, err
	}
	rows, err := s.db.Query("SELECT data FROM evaluation_outcomes WHERE evaluation_id=$1 ORDER BY seq", id)
	if err != nil {
		return d, err
	}
	defer rows.Close()
	for rows.Next() {
		var raw []byte
		var o EvaluationOutcome
		if err = rows.Scan(&raw); err != nil {
			return d, err
		}
		if err = decodeStored(raw, &o); err != nil {
			return d, err
		}
		d.Outcomes = append(d.Outcomes, o)
	}
	if err = rows.Err(); err != nil {
		return d, err
	}
	d.Summary = evaluationDetailSummary(d)
	return d, nil
}
func (s *Store) evaluations() ([]Evaluation, error) {
	rows, err := s.db.Query("SELECT summary FROM evaluations ORDER BY created_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Evaluation{}
	for rows.Next() {
		var raw []byte
		var e Evaluation
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err = decodeStored(raw, &e); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
func (s *Store) interruptEvaluations() error {
	list, err := s.evaluations()
	if err != nil {
		return err
	}
	for _, item := range list {
		if item.Status != "queued" && item.Status != "running" && item.Status != "stopping" {
			continue
		}
		d, err := s.evaluationDetail(item.ID)
		if err != nil {
			return err
		}
		changed := []EvaluationOutcome{}
		for i := range d.Outcomes {
			o := &d.Outcomes[i].Outcome
			if o.Status == "pending" || o.Status == "running" {
				o.Status = "interrupted"
				o.Error = "server restarted; judgment may have been sent; not resent"
				o.FinishedAt = now()
				d.Evaluation.Interrupted++
				changed = append(changed, d.Outcomes[i])
			}
		}
		d.Evaluation.Status = "interrupted"
		d.Evaluation.Error = "server restarted; execution not resumed or resent"
		d.Evaluation.InFlight = 0
		d.Evaluation.FinishedAt = now()
		if err = s.updateEvaluation(d, false, changed...); err != nil {
			return err
		}
	}
	return nil
}
