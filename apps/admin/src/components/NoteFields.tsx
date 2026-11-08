import {
  MAX_LINK,
  MAX_REASON,
  type NoteDraft,
  type NoteErrors,
  type NotePolicy,
} from '../changeNote';
import { Field } from './ui';

/**
 * The reason and ticket link a change carries into History. Each is marked
 * required when the environment asks for it. Without `reason`, only the link
 * shows, for forms where something else (a change request's title) is the reason.
 */
export function NoteFields({
  value,
  onChange,
  policy,
  envName,
  errors,
  reason = true,
  autoFocus = false,
}: {
  value: NoteDraft;
  onChange: (next: NoteDraft) => void;
  policy: NotePolicy;
  envName: string;
  errors: NoteErrors;
  reason?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div className="note-fields">
      {reason && (
        <Field
          label={policy.requireReason ? 'Reason' : 'Reason (optional)'}
          hint={
            policy.requireReason
              ? `${envName} asks why for every change. It shows in History.`
              : 'Shows in History next to the change.'
          }
          error={errors.reason}
        >
          {(p) => (
            <input
              {...p}
              type="text"
              value={value.reason}
              maxLength={MAX_REASON}
              required={policy.requireReason}
              data-autofocus={autoFocus ? true : undefined}
              onChange={(e) => {
                onChange({ ...value, reason: e.target.value });
              }}
            />
          )}
        </Field>
      )}
      <Field
        label={policy.requireLink ? 'Ticket link' : 'Ticket link (optional)'}
        hint={
          policy.requireLink
            ? `${envName} asks for a ticket or incident link for every change.`
            : 'A ticket or incident, like https://tracker.example.com/INC-42.'
        }
        error={errors.link}
      >
        {(p) => (
          <input
            {...p}
            type="url"
            inputMode="url"
            value={value.link}
            maxLength={MAX_LINK}
            required={policy.requireLink}
            placeholder="https://"
            data-autofocus={autoFocus && !reason ? true : undefined}
            onChange={(e) => {
              onChange({ ...value, link: e.target.value });
            }}
          />
        )}
      </Field>
    </div>
  );
}
