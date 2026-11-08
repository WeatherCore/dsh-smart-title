window.__ModuleLoader__.load({
  id: 'dsh-smart-title',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dshSmartTitle';

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() =>
          ctx.locale.register(NS, {
            en: {
              'btn.updateTitle': '✎ Update Title',
              'btn.titleTip': 'Regenerate title with AI (Shift+Click to edit manually)',
              'prompt.editTitle': 'Enter new conversation title:',
              'error.updateFailed': 'Failed to update title: ',
            },
            zh: {
              'btn.updateTitle': '✎ 更新标题',
              'btn.titleTip': '用 AI 重新生成标题（Shift+点击手动编辑）',
              'prompt.editTitle': '输入新的对话标题：',
              'error.updateFailed': '更新标题失败：',
            },
            'pt-BR': {
              'btn.updateTitle': '✎ Atualizar Título',
              'btn.titleTip': 'Regenerar título com IA (Shift+Clique para editar manualmente)',
              'prompt.editTitle': 'Digite o novo título da conversa:',
              'error.updateFailed': 'Falha ao atualizar o título: ',
            },
            pt: {
              'btn.updateTitle': '✎ Atualizar Título',
              'btn.titleTip': 'Regenerar título com IA (Shift+Clique para editar manualmente)',
              'prompt.editTitle': 'Digite o novo título da conversa:',
              'error.updateFailed': 'Falha ao atualizar o título: ',
            },
            ja: {
              'btn.updateTitle': '✎ タイトルを更新',
              'btn.titleTip': 'AIでタイトルを再生成（Shift+クリックで手動編集）',
              'prompt.editTitle': '新しい会話タイトルを入力：',
              'error.updateFailed': 'タイトルの更新に失敗しました：',
            },
          })
        );

        function UpdateTitleButton(props) {
          const [loading, setLoading] = React.useState(false);
          const [hovered, setHovered] = React.useState(false);
          const [, setTick] = React.useState(0);

          React.useEffect(() => {
            return ctx.locale?.subscribe
              ? ctx.locale.subscribe(() => setTick((t) => t + 1))
              : undefined;
          }, []);

          const t = ctx.locale?.bind ? ctx.locale.bind(NS) : (k) => k;
          const activeLocale = ctx.locale?.getLocale
            ? ctx.locale.getLocale().active
            : 'en';

          const onClick = async (e) => {
            if (loading) return;
            const sessionId = props.sessionId;
            if (!sessionId) return;

            let manualTitle;
            if (e.shiftKey || e.altKey) {
              const input = window.prompt(t('prompt.editTitle'));
              if (input === null) return;
              manualTitle = input.trim();
              if (!manualTitle) return;
            }

            setLoading(true);
            try {
              const res = await fetch('/api/session-title/update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  sessionId,
                  title: manualTitle || undefined,
                  locale: activeLocale,
                }),
              });
              const data = await res.json().catch(() => ({}));
              if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            } catch (err) {
              console.error('[dsh-smart-title]', err);
              alert(t('error.updateFailed') + (err.message || String(err)));
            } finally {
              setLoading(false);
            }
          };

          return h(
            'button',
            {
              type: 'button',
              onClick,
              onMouseEnter: () => setHovered(true),
              onMouseLeave: () => setHovered(false),
              title: t('btn.titleTip'),
              'aria-label': t('btn.updateTitle'),
              disabled: loading,
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                padding: '2px 8px',
                height: '24px',
                fontSize: '12px',
                lineHeight: '18px',
                borderRadius: 'var(--dsw-radius-xs, 4px)',
                border: '1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.15))',
                background: hovered
                  ? 'var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08))'
                  : 'transparent',
                color: hovered
                  ? 'var(--dsw-alias-label-primary, #ffffff)'
                  : 'var(--dsw-alias-label-secondary, #a0a0a0)',
                cursor: loading ? 'wait' : 'pointer',
                transition: 'background 0.15s, color 0.15s',
              },
            },
            loading ? '...' : t('btn.updateTitle')
          );
        }

        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'dsh-smart-title-action',
              order: 0,
            },
            UpdateTitleButton
          )
        );
      },
    };
  },
});
