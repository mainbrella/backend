package main

import (
	"database/sql"
	"encoding/json"
	"log"
	"net/http"

	_ "modernc.org/sqlite"
)

type user struct {
	ID    int    `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

func main() {
	db, err := sql.Open("sqlite", "/workspace/users.sqlite")
	if err != nil { log.Fatal(err) }
	defer db.Close()
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
		INSERT OR IGNORE INTO users VALUES (1, 'Ada Lovelace', 'ada@example.com'),
		(2, 'Grace Hopper', 'grace@example.com'), (3, 'Linus Torvalds', 'linus@example.com');`)
	if err != nil { log.Fatal(err) }
	http.HandleFunc("/users", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet { w.WriteHeader(http.StatusMethodNotAllowed); return }
		rows, err := db.QueryContext(r.Context(), "SELECT * FROM users ORDER BY id")
		if err != nil { http.Error(w, "Database unavailable", http.StatusServiceUnavailable); return }
		defer rows.Close()
		users := make([]user, 0, 3)
		for rows.Next() {
			var u user
			if err := rows.Scan(&u.ID, &u.Name, &u.Email); err != nil { http.Error(w, "Database unavailable", 503); return }
			users = append(users, u)
		}
		if rows.Err() != nil { http.Error(w, "Database unavailable", 503); return }
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"users": users})
	})
	log.Fatal(http.ListenAndServe(":8080", nil))
}
