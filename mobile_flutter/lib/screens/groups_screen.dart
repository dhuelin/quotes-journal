import 'package:flutter/material.dart';

import '../api.dart';
import '../main.dart';

class GroupsScreen extends StatefulWidget {
  const GroupsScreen({super.key, required this.api});

  final QuotesApi api;

  @override
  State<GroupsScreen> createState() => _GroupsScreenState();
}

class _GroupsScreenState extends State<GroupsScreen> {
  List<Map<String, dynamic>> _groups = const [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final result = await runCall(context, widget.api.me);
    if (!mounted) {
      return;
    }

    setState(() {
      _loading = false;
      final groups = result?.body['groups'];
      _groups = groups is List ? groups.whereType<Map<String, dynamic>>().toList() : const [];
    });
  }

  Future<void> _open(String groupId) async {
    await Navigator.of(context).push(groupRoute(widget.api, groupId));
    if (mounted) {
      await _load();
    }
  }

  Future<void> _createGroup() async {
    final name = await _promptForText(
      title: 'Start a group',
      label: 'Group name',
      fieldKey: const Key('new-group-name-field'),
    );
    if (name == null || name.isEmpty || !mounted) {
      return;
    }

    final result = await runCall(
      context,
      () => widget.api.createGroup(name: name, revealYear: DateTime.now().year),
      successMessage: 'Group created. Share the invite from the members tab.',
    );

    if (result != null && mounted) {
      await _load();
      final group = result.body['group'];
      if (group is Map && group['id'] is String) {
        await _open(group['id'] as String);
      }
    }
  }

  Future<void> _joinGroup() async {
    final code = await _promptForText(
      title: 'Join a group',
      label: 'Invite link or code',
      fieldKey: const Key('invite-code-field'),
    );
    if (code == null || code.isEmpty || !mounted) {
      return;
    }

    final result = await runCall(
      context,
      () => widget.api.acceptInvite(inviteCode: readInviteCode(code)),
      successMessage: 'You joined the group.',
    );

    if (result != null && mounted) {
      await _load();
    }
  }

  Future<String?> _promptForText({
    required String title,
    required String label,
    required Key fieldKey,
  }) {
    final controller = TextEditingController();
    return showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(title),
        content: TextField(
          key: fieldKey,
          controller: controller,
          autofocus: true,
          decoration: InputDecoration(labelText: label),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            key: const Key('dialog-confirm'),
            onPressed: () => Navigator.of(dialogContext).pop(controller.text.trim()),
            child: const Text('Done'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Your groups'),
        actions: [
          IconButton(
            key: const Key('join-group-button'),
            tooltip: 'Join with an invite',
            onPressed: _joinGroup,
            icon: const Icon(Icons.link),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        key: const Key('create-group-button'),
        onPressed: _createGroup,
        icon: const Icon(Icons.add),
        label: const Text('New group'),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: _groups.isEmpty
                  ? ListView(
                      children: const [
                        SizedBox(height: 120),
                        Padding(
                          padding: EdgeInsets.symmetric(horizontal: 32),
                          child: Text(
                            'No groups yet. Start one, or join with an invite link '
                            'a friend sent you.',
                            textAlign: TextAlign.center,
                          ),
                        ),
                      ],
                    )
                  : ListView.separated(
                      itemCount: _groups.length,
                      separatorBuilder: (_, _) => const Divider(height: 1),
                      itemBuilder: (context, index) {
                        final group = _groups[index];
                        final revealYear = group['revealYear'];
                        final year = revealYear is int ? revealYear : DateTime.now().year;

                        return ListTile(
                          title: Text('${group['name']}'),
                          subtitle: Text(
                            DateTime.now().isBefore(DateTime.utc(year + 1))
                                ? 'Sealed until 1 January ${year + 1}'
                                : 'Open since 1 January ${year + 1}',
                          ),
                          trailing: const Icon(Icons.chevron_right),
                          onTap: () => _open('${group['groupId']}'),
                        );
                      },
                    ),
            ),
    );
  }
}
