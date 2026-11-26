-- MEEHOA OPS V3.1 — Group 3A: Enforce DB-level unique normalized username on public.app_users
-- Prevents concurrent or duplicate create-account requests from overwriting or duplicating accounts.
-- Verified 0 existing duplicates across all 18 Production accounts prior to migration.

CREATE OR REPLACE FUNCTION public.mee_username_norm(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT lower(
    regexp_replace(
      translate(
        trim(input),
        'đĐáàảãạăắằẳẵặâấầẩẫậéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵÁÀẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬÉÈẺẼẸÊẾỀỂỄỆÍÌỈĨỊÓÒỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÚÙỦŨỤƯỨỪỬỮỰÝỲỶỸỴ',
        'dDaaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyAAAAAAAAAAAAAAAAAEEEEEEEEEEEIIIIIOOOOOOOOOOOOOOOOOUUUUUUUUUUUYYYYY'
      ),
      '[[:space:]]+',
      '',
      'g'
    )
  );
$$;

DO $$
DECLARE
  v_dup_count integer;
BEGIN
  SELECT count(*) INTO v_dup_count
  FROM (
    SELECT public.mee_username_norm(username) AS norm_u
    FROM public.app_users
    GROUP BY 1
    HAVING count(*) > 1
  ) d;

  IF v_dup_count > 0 THEN
    RAISE EXCEPTION 'Cannot create unique normalized username index: % duplicate group(s) found in public.app_users', v_dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_username_norm_unique
  ON public.app_users (public.mee_username_norm(username));
