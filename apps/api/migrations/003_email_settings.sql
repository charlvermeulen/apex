create table email_settings (
  company_id uuid primary key references companies(id) on delete cascade,
  mode text not null default 'simulate' check (mode in ('simulate','mailto','relay')),
  host text,
  port int check (port between 1 and 65535),
  security text not null default 'starttls' check (security in ('starttls','ssl','none')),
  smtp_user text,
  smtp_pass_enc text,
  save_pass boolean not null default false,
  from_name text,
  from_email text,
  reply_to text,
  bcc text,
  relay_url text,
  relay_token text,
  subject_tpl text not null default 'Statement of account — {customer} — {date}',
  body_tpl text not null default '<p>Dear {customer},</p><p>Thank you for your business. Please find your statement dated {date} attached.</p><p>Kindly settle the outstanding balance by {terms}. Feel free to contact us if you have any questions.</p><p>Regards</p>',
  updated_at timestamptz not null default now()
);
