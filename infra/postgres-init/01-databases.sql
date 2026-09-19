-- One Postgres instance, three logical databases.
-- Each service owns its schema and migrations; nothing crosses databases
-- except through the event backbone or the typed HTTP APIs.
CREATE DATABASE rostering;
CREATE DATABASE time_attendance;
CREATE DATABASE studio;
