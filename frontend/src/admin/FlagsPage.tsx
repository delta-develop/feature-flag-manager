import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, errorText, KEY_PATTERN, type Flag, type FlagChanges } from "../api";
import { timeAgo } from "../format";
import { seriesColor, Sparkline, useEvaluationTimeseries } from "../charts";

const FLAGS_QUERY = ["flags"];

export default function FlagsPage() {
  // Refetch so evaluation counts move while the demo is running.
  const flags = useQuery({ queryKey: FLAGS_QUERY, queryFn: api.listFlags, refetchInterval: 5000 });
  const timeseries = useEvaluationTimeseries(30);
  const knownKeys = flags.data?.map((f) => f.key) ?? [];

  return (
    <>
      <h1>Flags</h1>
      <CreateFlagForm />
      <section aria-labelledby="flags-heading">
        <h2 id="flags-heading">All flags</h2>
        {flags.isPending && <p>Loading…</p>}
        {flags.isError && <p role="alert" className="error">{errorText(flags.error)}</p>}
        {flags.data?.length === 0 && <p className="muted">No flags yet. Create the first one above.</p>}
        {flags.data && flags.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Description</th>
                <th scope="col">Status</th>
                <th scope="col">Evaluations</th>
                <th scope="col">Activity (30 min)</th>
                <th scope="col">Last evaluated</th>
                <th scope="col"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {flags.data.map((flag) => (
                <FlagRow
                  key={flag.key}
                  flag={flag}
                  activity={timeseries.data ? (timeseries.data.series[flag.key] ?? timeseries.data.buckets.map(() => 0)) : null}
                  color={seriesColor(flag.key, knownKeys)}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function CreateFlagForm() {
  const queryClient = useQueryClient();
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: api.createFlag,
    onSuccess: () => {
      setKey("");
      setDescription("");
      queryClient.invalidateQueries({ queryKey: FLAGS_QUERY });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "flag_already_exists") setKeyError(err.message);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (key.length < 2 || key.length > 64 || !KEY_PATTERN.test(key)) {
      setKeyError("Use 2–64 lowercase letters, numbers and single hyphens (e.g. new-checkout).");
      return;
    }
    setKeyError(null);
    create.mutate({ key, description });
  }

  const isKeyConflict = create.error instanceof ApiError && create.error.code === "flag_already_exists";
  const formError = create.isError && !isKeyConflict ? errorText(create.error) : "";

  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="create-heading">
      <h2 id="create-heading">Create flag</h2>
      <div className="form-row">
        <div className="field">
          <label htmlFor="flag-key">Key</label>
          <input
            id="flag-key"
            value={key}
            onChange={(e) => setKey(e.target.value.trim())}
            placeholder="new-checkout"
            autoComplete="off"
            aria-invalid={keyError ? true : undefined}
            aria-describedby="flag-key-hint flag-key-error"
          />
          <small id="flag-key-hint">Lowercase, hyphen-separated. Can't be renamed later.</small>
          <p id="flag-key-error" className="error" aria-live="polite">{keyError}</p>
        </div>
        <div className="field">
          <label htmlFor="flag-description">Description</label>
          <input
            id="flag-description"
            value={description}
            maxLength={280}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>
      <button type="submit" disabled={create.isPending}>
        {create.isPending ? "Creating…" : "Create flag"}
      </button>
      <p className="error" role="alert">{formError}</p>
    </form>
  );
}

function FlagRow({ flag, activity, color }: { flag: Flag; activity: number[] | null; color: string }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(flag.description);
  const refresh = () => queryClient.invalidateQueries({ queryKey: FLAGS_QUERY });

  const update = useMutation({
    mutationFn: (changes: FlagChanges) => api.updateFlag(flag.key, changes),
    onSuccess: () => {
      setEditing(false);
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: () => api.deleteFlag(flag.key), onSuccess: refresh });
  const error = update.error ?? remove.error;

  function confirmDelete() {
    if (window.confirm(`Delete "${flag.key}"? Clients still using it will receive false.`)) remove.mutate();
  }

  return (
    <tr>
      <th scope="row">
        <code>{flag.key}</code>
        {error && <p role="alert" className="error">{errorText(error)}</p>}
      </th>
      <td>
        {editing ? (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate({ description: draft });
            }}
          >
            <label className="visually-hidden" htmlFor={`desc-${flag.key}`}>Description of {flag.key}</label>
            <input
              id={`desc-${flag.key}`}
              value={draft}
              maxLength={280}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
            />
            <button type="submit" disabled={update.isPending}>Save</button>
            <button type="button" onClick={() => setEditing(false)}>Cancel</button>
          </form>
        ) : (
          <>
            {flag.description || <span className="muted">No description</span>}
            <button
              type="button"
              className="link"
              aria-label={`Edit description of ${flag.key}`}
              onClick={() => {
                setDraft(flag.description);
                setEditing(true);
              }}
            >
              Edit
            </button>
          </>
        )}
      </td>
      <td>
        <button
          type="button"
          role="switch"
          aria-checked={flag.enabled}
          aria-label={`${flag.key} enabled`}
          className={`switch ${flag.enabled ? "on" : "off"}`}
          disabled={update.isPending}
          onClick={() => update.mutate({ enabled: !flag.enabled })}
        >
          {flag.enabled ? "ON" : "OFF"}
        </button>
      </td>
      <td>{flag.evaluation_count}</td>
      <td>
        {activity && (
          <Sparkline
            values={activity}
            color={color}
            label={`${activity.reduce((a, b) => a + b, 0)} evaluations of ${flag.key} in the last 30 minutes`}
          />
        )}
      </td>
      <td>{timeAgo(flag.last_evaluated_at)}</td>
      <td>
        <button type="button" className="danger" disabled={remove.isPending} onClick={confirmDelete}>
          Delete
        </button>
      </td>
    </tr>
  );
}
