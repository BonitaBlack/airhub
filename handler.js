const Airtable = require('airtable');
const GitHub = require('github-api');
const randomColor = require('random-color');

const gh = new GitHub({ token: process.env.GITHUB_API_KEY });

const issues = gh.getIssues(process.env.REPO_OWNER, process.env.REPO_NAME);
const airtable = new Airtable().base(process.env.AIRTABLE_BASE);

function name2Label(name) {
  return `proj:${name.toLowerCase().replace(/ /g, '-')}`;
}

async function syncProjectLabels() {
  const projId2Label = new Map((await issues.listLabels({ AcceptHeader: 'symmetra-preview' }))
    .data.map(label => [label.description, label.name]));

  const projects = (await airtable('Projects').select({
    fields: ['Name'],
    filterByFormula: '{GitHub} = 1',
  }).all());

  await Promise.all(projects.map(proj => {
    if (projId2Label.has(proj.id)) return;
    return issues.createLabel({
      name: name2Label(proj.get('Name')),
      color: randomColor().hexString().slice(1),
      description: proj.id,
      AcceptHeader: 'symmetra-preview',
    });
  }));

  return projId2Label;
}

function getIssueBody(task) {
  const desc = (task.get('Notes') || '').trim();
  let body = desc ? `${desc}\n\n` : '';
  body += `Time Estimate (days): ${task.get('Time Estimate')}`;
  body += `\n\n[Airtable link](${process.env.AIRTABLE_LINK_PRE}${task.id})`;
  return body;
}

function setEq(a, b) {
  const bSet = new Set(b);
  return a.reduce((eq, v) => (eq && bSet.has(v)), true);
}

module.exports.init = async (_event, _context) => {
  // delete all existing labels
  await Promise.all((await issues.listLabels({})).data
    .map(label => issues.deleteLabel(label.name)));

  return syncProjectLabels();
};

module.exports.transferTasks = async (_event, _context) => {
  const projId2Label = await syncProjectLabels();

  const openTasks = await airtable('Tasks').select({
    fields: ['Name', 'Notes', 'Time Estimate', 'Project'],
    view: 'Main View',
    filterByFormula: 'NOT({Status} = "done")',
  }).all();
  const openTaskIds = new Set(openTasks.map(task => task.id));

  const openIssues = (await issues.listIssues({ state: 'open' })).data;
  const openIssueByTaskId = new Map(openIssues
    .map(issue => {
      const match = /\[Airtable link\].*\/(rec\w+)\)/.exec(issue.body);
      if (match === null) return null;
      return [match[1], issue];
    })
    .filter(kv => kv !== undefined));

  function getIssueLabels(task) {
    return task.get('Project')
      .map(projId => projId2Label.get(projId))
      .filter(label => label !== undefined);
  }

  const createIssuesFromTasks = openTasks.map(task => {
    if (openIssueByTaskId.has(task.id)) return;

    const labels = getIssueLabels(task);
    if (labels.length === 0) return;

    return issues.createIssue({
      title: task.get('Name'),
      body: getIssueBody(task),
      labels,
    });
  });

  const closeCompletedTaskIssues = Array.from(openIssueByTaskId.entries())
    .map(([taskId, issue]) => {
      if (openTaskIds.has(taskId)) return;
      return issues.editIssue(issue.number, { state: 'closed' });
    });

  const updateIssuesFromChangedTasks = openTasks
    .map(task => {
      const issue = openIssueByTaskId.get(task.id);
      if (issue === undefined) return;

      const newBody = getIssueBody(task);
      const curLabels = issue.labels.map(l => l.name);
      const newLabels = getIssueLabels(task);
      const changed = issue.title !== task.get('Name')
        || issue.body !== newBody
        || !setEq(curLabels, newLabels);
      if (!changed) return;
      return issues.editIssue(issue.number, {
        title: task.get('Name'),
        body: newBody,
        labels: newLabels,
      });
    });

  return Promise.all(createIssuesFromTasks
    .concat(closeCompletedTaskIssues)
    .concat(updateIssuesFromChangedTasks));
};
