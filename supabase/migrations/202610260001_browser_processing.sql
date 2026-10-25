-- Private tables are accessed only by the authenticated storage gateway.
create table public.ml_sessions (
  id text primary key check (length(id) = 64),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  preferences jsonb not null default '{}'::jsonb
);
create table public.ml_documents (
  id uuid primary key,
  owner text not null references public.ml_sessions(id),
  kind text not null check (kind in ('project', 'page')),
  project_id uuid references public.ml_documents(id) on delete cascade,
  data jsonb not null,
  version bigint not null default 1,
  expires_at timestamptz not null default now() + interval '7 days'
);
create index ml_documents_owner_kind on public.ml_documents(owner, kind);
create index ml_documents_project on public.ml_documents(project_id);
create index ml_documents_expiry on public.ml_documents(expires_at);
create index ml_documents_regions on public.ml_documents using gin ((data->'regions'));
create table public.ml_usage (
  id bigint generated always as identity primary key,
  owner text not null,
  kind text not null check (kind in ('ocr', 'deepl', 'session')),
  amount integer not null check (amount >= 0),
  engine integer not null default 0,
  created_at timestamptz not null default now()
);
create index ml_usage_period on public.ml_usage(kind, created_at);
alter table public.ml_sessions enable row level security;
alter table public.ml_documents enable row level security;
alter table public.ml_usage enable row level security;
revoke all on public.ml_sessions, public.ml_documents, public.ml_usage from anon, authenticated;
grant all on public.ml_sessions, public.ml_documents, public.ml_usage to service_role;
grant usage, select on sequence public.ml_usage_id_seq to service_role;

-- Shared-account budgets are committed BEFORE a provider request. Failed/uncertain
-- calls still count, including calls from sessions whose projects were deleted.
create function public.ml_reserve_budget(p_owner text, p_kind text, p_amount integer, p_engine integer default 0)
returns void language plpgsql security invoker set search_path = public as $$
declare daily_count bigint; monthly_count bigint; engine_count bigint; chars bigint;
begin
  perform pg_advisory_xact_lock(hashtext('mangalens-provider-budget'));
  if p_amount < 0 or p_amount > 30000 then raise exception 'Invalid usage amount'; end if;
  select count(*) filter (where created_at >= date_trunc('day', now())),
         count(*), count(*) filter (where engine = 3), coalesce(sum(amount),0)
    into daily_count, monthly_count, engine_count, chars
    from public.ml_usage where kind = p_kind and created_at >= date_trunc('month', now());
  if p_kind = 'ocr' then
    if daily_count >= 50 or monthly_count >= 400 or (p_engine = 3 and engine_count >= 300)
      then raise exception 'OCR.space free usage budget reached. Try again after the quota resets.'; end if;
  elsif p_kind = 'deepl' then
    if chars + p_amount > 100000 then raise exception 'DeepL monthly character budget reached.'; end if;
  elsif p_kind = 'session' then
    if daily_count >= 100 then raise exception 'Daily session limit reached.'; end if;
  else raise exception 'Invalid usage category';
  end if;
  insert into public.ml_usage(owner,kind,amount,engine) values(p_owner,p_kind,p_amount,p_engine);
  delete from public.ml_usage where created_at < now() - interval '45 days';
end $$;
revoke all on function public.ml_reserve_budget(text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.ml_reserve_budget(text,text,integer,integer) to service_role;

create function public.ml_create_pages(p_owner text, p_project uuid, p_pages jsonb)
returns void language plpgsql security invoker set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext('mangalens-storage-capacity'));
  if not exists(select 1 from public.ml_documents where id=p_project and owner=p_owner and kind='project')
    then raise exception 'Project not found'; end if;
  if jsonb_array_length(p_pages) < 1 or jsonb_array_length(p_pages) > 20
    then raise exception 'Import between 1 and 20 pages'; end if;
  if (select count(*) from public.ml_documents where kind='page') + jsonb_array_length(p_pages) > 20
    then raise exception 'Free storage page limit reached. Delete an old chapter before importing more pages.'; end if;
  insert into public.ml_documents(id,owner,kind,project_id,data,expires_at)
    select (p->>'id')::uuid,p_owner,'page',p_project,p,
      (select expires_at from public.ml_documents where id=p_project)
    from jsonb_array_elements(p_pages) p;
end $$;
revoke all on function public.ml_create_pages(text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.ml_create_pages(text,uuid,jsonb) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('mangalens','mangalens',false,8388608,array['image/png'])
on conflict(id) do update set public=false, file_size_limit=8388608, allowed_mime_types=array['image/png'];
