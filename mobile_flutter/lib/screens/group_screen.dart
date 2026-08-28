import 'package:flutter/material.dart';

import '../api.dart';
import '../main.dart';

/// One group: capture quotes while the year runs, then read the reveal.
class GroupScreen extends StatefulWidget {
  const GroupScreen({super.key, required this.api, required this.groupId});

  final QuotesApi api;
  final String groupId;

  @override
  State<GroupScreen> createState() => _GroupScreenState();
}

class _GroupScreenState extends State<GroupScreen> {
  Map<String, dynamic>? _group;
  bool _loading = true;

  List<Map<String, dynamic>> get _members {
    final members = _group?['members'];
    return members is List ? members.whereType<Map<String, dynamic>>().toList() : const [];
  }

  bool get _locked => _group?['locked'] == true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final result = await runCall(context, () => widget.api.group(groupId: widget.groupId));
    if (!mounted) {
      return;
    }

    setState(() {
      _loading = false;
      final group = result?.body['group'];
      _group = group is Map<String, dynamic> ? group : null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final group = _group;

    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    if (group == null) {
      return Scaffold(
        appBar: AppBar(),
        body: const Center(child: Text('This group could not be opened.')),
      );
    }

    final tabCount = _locked ? 2 : 3;

    return DefaultTabController(
      length: tabCount,
      child: Scaffold(
        appBar: AppBar(
          title: Text('${group['name']}'),
          bottom: TabBar(
            tabs: [
              const Tab(text: 'Add a quote'),
              const Tab(text: 'Members'),
              if (!_locked) const Tab(text: 'The reveal'),
            ],
          ),
        ),
        body: TabBarView(
          children: [
            _CollectTab(api: widget.api, group: group, members: _members, onSaved: _load),
            _MembersTab(api: widget.api, group: group, members: _members, onChanged: _load),
            if (!_locked) _RevealTab(api: widget.api, groupId: widget.groupId, members: _members),
          ],
        ),
      ),
    );
  }
}

class _CollectTab extends StatefulWidget {
  const _CollectTab({
    required this.api,
    required this.group,
    required this.members,
    required this.onSaved,
  });

  final QuotesApi api;
  final Map<String, dynamic> group;
  final List<Map<String, dynamic>> members;
  final Future<void> Function() onSaved;

  @override
  State<_CollectTab> createState() => _CollectTabState();
}

class _CollectTabState extends State<_CollectTab> {
  final _text = TextEditingController();
  final Set<String> _involved = <String>{};
  String? _saidBy;
  bool _busy = false;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final saidBy = _saidBy;
    if (saidBy == null || _text.text.trim().isEmpty) {
      return;
    }

    setState(() => _busy = true);
    final result = await runCall(
      context,
      () => widget.api.addQuote(
        groupId: '${widget.group['id']}',
        text: _text.text.trim(),
        saidByMemberId: saidBy,
        involvedMemberIds: _involved.toList(),
      ),
      successMessage: 'Saved. It is sealed until the reveal.',
    );

    if (!mounted) {
      return;
    }
    setState(() => _busy = false);

    if (result != null) {
      _text.clear();
      _involved.clear();
      await widget.onSaved();
    }
  }

  @override
  Widget build(BuildContext context) {
    final progress = widget.group['progress'];
    final total = progress is Map ? progress['totalQuotes'] : 0;
    final mine = progress is Map ? progress['recordedByYou'] : 0;
    final youId = (widget.group['you'] as Map?)?['memberId'];

    _saidBy ??= widget.members.isEmpty ? null : '${widget.members.first['id']}';

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        TextField(
          key: const Key('quote-text-field'),
          controller: _text,
          maxLines: 3,
          maxLength: 500,
          decoration: const InputDecoration(
            labelText: 'What was said?',
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 8),
        DropdownButtonFormField<String>(
          key: const Key('said-by-field'),
          initialValue: _saidBy,
          decoration: const InputDecoration(labelText: 'Who said it?'),
          items: [
            for (final member in widget.members)
              DropdownMenuItem(
                value: '${member['id']}',
                child: Text('${member['name']}${member['isYou'] == true ? ' (you)' : ''}'),
              ),
          ],
          onChanged: (value) => setState(() => _saidBy = value),
        ),
        const SizedBox(height: 16),
        if (widget.members.length > 1) ...[
          const Text('Who else was there?'),
          Wrap(
            spacing: 8,
            children: [
              for (final member in widget.members)
                if (member['id'] != youId)
                  FilterChip(
                    label: Text('${member['name']}'),
                    selected: _involved.contains('${member['id']}'),
                    onSelected: (selected) => setState(() {
                      final id = '${member['id']}';
                      if (selected) {
                        _involved.add(id);
                      } else {
                        _involved.remove(id);
                      }
                    }),
                  ),
            ],
          ),
          const SizedBox(height: 16),
        ],
        FilledButton(
          key: const Key('save-quote-button'),
          onPressed: _busy ? null : _save,
          child: const Text('Save quote'),
        ),
        const SizedBox(height: 24),
        Center(
          child: Column(
            children: [
              Text('$total', style: Theme.of(context).textTheme.displaySmall),
              Text('quotes collected so far · $mine by you'),
            ],
          ),
        ),
      ],
    );
  }
}

class _MembersTab extends StatelessWidget {
  const _MembersTab({
    required this.api,
    required this.group,
    required this.members,
    required this.onChanged,
  });

  final QuotesApi api;
  final Map<String, dynamic> group;
  final List<Map<String, dynamic>> members;
  final Future<void> Function() onChanged;

  Future<void> _addMember(BuildContext context) async {
    final controller = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Add someone without an account'),
        content: TextField(
          key: const Key('member-name-field'),
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(labelText: 'Name'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(controller.text.trim()),
            child: const Text('Add'),
          ),
        ],
      ),
    );

    if (name == null || name.isEmpty || !context.mounted) {
      return;
    }

    final result = await runCall(
      context,
      () => api.addMember(groupId: '${group['id']}', name: name),
      successMessage: 'Member added.',
    );

    if (result != null) {
      await onChanged();
    }
  }

  Future<void> _showInvite(BuildContext context) async {
    final result = await runCall(context, () => api.invite(groupId: '${group['id']}'));
    if (result == null || !context.mounted) {
      return;
    }

    await showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Invite a friend'),
        // Composed here from the configured base URL: the Worker returns only
        // the code, so a link can never inherit an attacker's Host header.
        content: SelectableText('${api.baseUrl}/join#invite=${result.body['inviteCode']}'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Close'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      children: [
        for (final member in members)
          ListTile(
            title: Text('${member['name']}'),
            subtitle: Text(member['isGuest'] == true ? 'not signed up' : '${member['role']}'),
            trailing: member['isYou'] == true ? const Chip(label: Text('you')) : null,
          ),
        const Divider(),
        ListTile(
          key: const Key('show-invite-tile'),
          leading: const Icon(Icons.link),
          title: const Text('Show invite link'),
          onTap: () => _showInvite(context),
        ),
        ListTile(
          key: const Key('add-member-tile'),
          leading: const Icon(Icons.person_add),
          title: const Text('Add someone without an account'),
          onTap: () => _addMember(context),
        ),
      ],
    );
  }
}

class _RevealTab extends StatefulWidget {
  const _RevealTab({required this.api, required this.groupId, required this.members});

  final QuotesApi api;
  final String groupId;
  final List<Map<String, dynamic>> members;

  @override
  State<_RevealTab> createState() => _RevealTabState();
}

class _RevealTabState extends State<_RevealTab> {
  List<Map<String, dynamic>> _quotes = const [];
  List<Map<String, dynamic>> _leaderboard = const [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final quotes = await runCall(context, () => widget.api.quotes(groupId: widget.groupId));
    if (!mounted) {
      return;
    }
    final stats = await runCall(context, () => widget.api.stats(groupId: widget.groupId));
    if (!mounted) {
      return;
    }

    setState(() {
      _loading = false;
      final quoteList = quotes?.body['quotes'];
      _quotes = quoteList is List ? quoteList.whereType<Map<String, dynamic>>().toList() : const [];
      final board = stats?.body['leaderboard'];
      _leaderboard = board is List ? board.whereType<Map<String, dynamic>>().toList() : const [];
    });
  }

  String _memberName(Object? memberId) {
    for (final member in widget.members) {
      if (member['id'] == memberId) {
        return '${member['name']}';
      }
    }
    return 'Unknown member';
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text('Statistics', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 8),
        for (final entry in _leaderboard)
          ListTile(
            dense: true,
            title: Text('${entry['name']}'),
            trailing: Text('quoted ${entry['said']} · collected ${entry['persisted']}'),
          ),
        const SizedBox(height: 24),
        Text('${_quotes.length} quotes', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 8),
        for (final quote in _quotes)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('${quote['text']}'),
                  const SizedBox(height: 6),
                  Text(
                    '— ${_memberName(quote['saidByMemberId'])}, '
                    'recorded by ${_memberName(quote['recordedByMemberId'])}',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}
